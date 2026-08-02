from dataclasses import replace

import pytest

from app.game import (
    BASE_SHOT_INTERVAL_MS,
    MAX_AMMO,
    MAX_HEALTH,
    RAPID_SHOT_INTERVAL_MS,
    SHOT_DAMAGE,
    SLOW_SHOT_INTERVAL_MS,
    SPELLS,
    GameState,
    PlayerState,
    add_player,
    cast_spell,
    create_game,
    fire,
    pause_game,
    remove_player,
    request_rematch,
    shot_interval_ms,
    start_game,
)


def playing_game() -> GameState:
    joined = add_player(create_game("ROOM", "one"), "two")
    assert joined.accepted
    started = start_game(joined.state)
    assert started.accepted
    return started.state


def update_player(
    state: GameState, player_id: str, **changes: object
) -> GameState:
    players = dict(state.players)
    players[player_id] = replace(players[player_id], **changes)
    return replace(state, players=players)


def test_room_reserves_exactly_two_player_slots() -> None:
    waiting = create_game("ROOM", "one")
    assert waiting.phase == "waiting"

    joined = add_player(waiting, "two")
    assert joined.accepted
    assert joined.state.phase == "waiting"
    assert list(joined.state.players) == ["one", "two"]

    started = start_game(joined.state)
    assert started.accepted
    assert started.state.phase == "playing"

    reconnect = add_player(started.state, "one")
    assert reconnect.accepted
    assert reconnect.state is started.state

    third = add_player(started.state, "three")
    assert not third.accepted
    assert third.reason == "room_full"
    assert third.state is started.state


def test_pause_preserves_combat_and_remove_resets_survivor() -> None:
    damaged = fire(playing_game(), "one", 1_000).state
    paused = pause_game(damaged)

    assert paused.phase == "waiting"
    assert paused.players["two"].health == MAX_HEALTH - SHOT_DAMAGE

    removed = remove_player(paused, "two")
    assert removed.accepted
    assert list(removed.state.players) == ["one"]
    assert removed.state.players["one"] == PlayerState(player_id="one")


def test_spell_configuration_matches_game_design() -> None:
    assert SPELLS["plus"].duration_ms == 6_000
    assert SPELLS["plus"].cooldown_ms == 12_000
    assert SPELLS["minus"].duration_ms == 5_000
    assert SPELLS["minus"].cooldown_ms == 12_000
    assert SPELLS["circle"].duration_ms == 4_000
    assert SPELLS["circle"].cooldown_ms == 14_000
    assert SPELLS["star"].duration_ms == 2_250
    assert SPELLS["star"].cooldown_ms == 15_000
    assert SPELLS["triangle"].duration_ms == 4_000
    assert SPELLS["triangle"].cooldown_ms == 16_000
    assert SPELLS["loop"].duration_ms == 0
    assert SPELLS["loop"].cooldown_ms == 5_000


@pytest.mark.parametrize(
    ("spell", "target_id", "effect", "duration_ms", "cooldown_ms"),
    [
        ("plus", "one", "rapid", 6_000, 12_000),
        ("minus", "two", "slow", 5_000, 12_000),
        ("circle", "one", "shield", 4_000, 14_000),
        ("star", "two", "blind", 2_250, 15_000),
        ("triangle", "one", "reflect", 4_000, 16_000),
    ],
)
def test_cast_applies_effect_to_the_right_player_and_starts_cooldown(
    spell: str,
    target_id: str,
    effect: str,
    duration_ms: int,
    cooldown_ms: int,
) -> None:
    now_ms = 10_000
    result = cast_spell(playing_game(), "one", spell, now_ms)

    assert result.accepted
    assert result.state.players[target_id].effects[effect] == now_ms + duration_ms
    assert result.state.players["one"].cooldowns[spell] == now_ms + cooldown_ms
    assert result.event == {
        "event": "spell_cast",
        "source_player_id": "one",
        "target_player_id": target_id,
        "spell": spell,
        "effect": effect,
        "duration_ms": duration_ms,
    }


def test_cast_rejects_spell_during_cooldown_without_changing_state() -> None:
    first = cast_spell(playing_game(), "one", "plus", 1_000)
    second = cast_spell(first.state, "one", "plus", 5_000)

    assert not second.accepted
    assert second.reason == "spell_cooldown"
    assert second.retry_after_ms == 8_000
    assert second.state is first.state


def test_loop_reloads_and_has_its_own_cooldown() -> None:
    state = update_player(playing_game(), "one", ammo=0)
    reload_result = cast_spell(state, "one", "loop", 2_000)

    assert reload_result.accepted
    assert reload_result.state.players["one"].ammo == MAX_AMMO
    assert reload_result.state.players["one"].cooldowns["loop"] == 7_000

    cooling_down = cast_spell(reload_result.state, "one", "loop", 3_000)
    assert not cooling_down.accepted
    assert cooling_down.reason == "spell_cooldown"
    assert cooling_down.retry_after_ms == 4_000

    already_full = cast_spell(reload_result.state, "one", "loop", 7_000)
    assert not already_full.accepted
    assert already_full.reason == "ammo_full"


def test_fire_damages_opponent_consumes_ammo_and_enforces_base_rate() -> None:
    first = fire(playing_game(), "one", 1_000)

    assert first.accepted
    assert first.state.players["one"].ammo == MAX_AMMO - 1
    assert first.state.players["one"].next_shot_at_ms == (
        1_000 + BASE_SHOT_INTERVAL_MS
    )
    assert first.state.players["two"].health == MAX_HEALTH - SHOT_DAMAGE
    assert first.event is not None
    assert first.event["outcome"] == "hit"
    assert first.event["damaged_player_id"] == "two"

    too_soon = fire(
        first.state, "one", 1_000 + BASE_SHOT_INTERVAL_MS - 1
    )
    assert not too_soon.accepted
    assert too_soon.reason == "fire_rate_limited"
    assert too_soon.retry_after_ms == 1
    assert too_soon.state is first.state

    ready = fire(first.state, "one", 1_000 + BASE_SHOT_INTERVAL_MS)
    assert ready.accepted


def test_fire_without_target_lock_misses_but_costs_a_shot() -> None:
    reflected = cast_spell(playing_game(), "two", "triangle", 1_000)
    result = fire(reflected.state, "one", 2_000, target_locked=False)

    assert result.accepted
    assert result.event is not None
    assert result.event["outcome"] == "missed"
    assert result.event["damage"] == 0
    assert result.event["damaged_player_id"] is None
    assert result.state.players["one"].health == MAX_HEALTH
    assert result.state.players["two"].health == MAX_HEALTH
    assert result.state.players["one"].ammo == MAX_AMMO - 1
    assert result.state.players["one"].next_shot_at_ms == (
        2_000 + BASE_SHOT_INTERVAL_MS
    )


def test_rapid_and_slow_effects_change_the_server_fire_rate() -> None:
    rapid = cast_spell(playing_game(), "one", "plus", 1_000)
    assert shot_interval_ms(rapid.state.players["one"], 2_000) == (
        RAPID_SHOT_INTERVAL_MS
    )
    assert shot_interval_ms(rapid.state.players["one"], 7_000) == (
        BASE_SHOT_INTERVAL_MS
    )

    slow = cast_spell(playing_game(), "two", "minus", 1_000)
    assert shot_interval_ms(slow.state.players["one"], 2_000) == (
        SLOW_SHOT_INTERVAL_MS
    )

    both = cast_spell(rapid.state, "two", "minus", 1_000)
    assert shot_interval_ms(both.state.players["one"], 2_000) == (
        BASE_SHOT_INTERVAL_MS
    )


def test_shield_blocks_a_shot_but_still_consumes_the_projectile() -> None:
    shielded = cast_spell(playing_game(), "two", "circle", 1_000)
    result = fire(shielded.state, "one", 2_000)

    assert result.accepted
    assert result.event is not None
    assert result.event["outcome"] == "blocked"
    assert result.event["damage"] == 0
    assert result.event["damaged_player_id"] is None
    assert result.state.players["two"].health == MAX_HEALTH
    assert result.state.players["one"].ammo == MAX_AMMO - 1


def test_reflect_damages_the_shooter() -> None:
    reflected = cast_spell(playing_game(), "two", "triangle", 1_000)
    result = fire(reflected.state, "one", 2_000)

    assert result.accepted
    assert result.event is not None
    assert result.event["outcome"] == "reflected"
    assert result.event["damage"] == SHOT_DAMAGE
    assert result.event["damaged_player_id"] == "one"
    assert result.state.players["one"].health == MAX_HEALTH - SHOT_DAMAGE
    assert result.state.players["two"].health == MAX_HEALTH


def test_lethal_hit_finishes_game_and_blocks_further_actions() -> None:
    state = update_player(playing_game(), "two", health=SHOT_DAMAGE)
    lethal = fire(state, "one", 1_000)

    assert lethal.accepted
    assert lethal.state.phase == "finished"
    assert lethal.state.winner_id == "one"
    assert lethal.state.players["two"].health == 0

    after_game = fire(lethal.state, "one", 2_000)
    assert not after_game.accepted
    assert after_game.reason == "game_not_active"


def test_lethal_reflection_awards_the_game_to_the_defender() -> None:
    state = update_player(playing_game(), "one", health=SHOT_DAMAGE)
    reflected = cast_spell(state, "two", "triangle", 1_000)
    lethal = fire(reflected.state, "one", 2_000)

    assert lethal.state.phase == "finished"
    assert lethal.state.winner_id == "two"
    assert lethal.state.players["one"].health == 0


def test_out_of_ammo_requires_a_loop_reload() -> None:
    state = update_player(playing_game(), "one", ammo=0)
    result = fire(state, "one", 1_000)

    assert not result.accepted
    assert result.reason == "out_of_ammo"
    assert result.state is state


def test_both_players_must_request_rematch_before_full_reset() -> None:
    state = update_player(playing_game(), "two", health=SHOT_DAMAGE)
    finished = fire(state, "one", 1_000).state
    state_with_status = update_player(
        finished,
        "one",
        ammo=1,
        effects={**finished.players["one"].effects, "rapid": 99_000},
        cooldowns={**finished.players["one"].cooldowns, "plus": 99_000},
    )

    first = request_rematch(state_with_status, "one")
    assert first.accepted
    assert first.state.phase == "finished"
    assert first.state.players["one"].wants_rematch

    duplicate = request_rematch(first.state, "one")
    assert not duplicate.accepted
    assert duplicate.reason == "rematch_already_requested"

    second = request_rematch(first.state, "two")
    assert second.accepted
    assert second.event is not None
    assert second.event["event"] == "rematch_started"
    assert second.state.phase == "waiting"
    assert second.state.winner_id is None
    for player in second.state.players.values():
        assert player == PlayerState(player_id=player.player_id)
