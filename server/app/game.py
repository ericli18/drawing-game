from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal, cast


MAX_HEALTH = 100
MAX_AMMO = 6
SHOT_DAMAGE = 12
BASE_SHOT_INTERVAL_MS = 800
RAPID_SHOT_INTERVAL_MS = 400
SLOW_SHOT_INTERVAL_MS = 1600

SpellName = Literal["plus", "minus", "circle", "star", "triangle", "loop"]
EffectName = Literal["rapid", "slow", "shield", "blind", "reflect"]
GamePhase = Literal["waiting", "playing", "finished"]

SPELL_NAMES: tuple[SpellName, ...] = (
    "plus",
    "minus",
    "circle",
    "star",
    "triangle",
    "loop",
)
EFFECT_NAMES: tuple[EffectName, ...] = (
    "rapid",
    "slow",
    "shield",
    "blind",
    "reflect",
)


@dataclass(frozen=True)
class SpellConfig:
    target: Literal["self", "opponent"]
    effect: EffectName | None
    duration_ms: int
    cooldown_ms: int


SPELLS: dict[SpellName, SpellConfig] = {
    "plus": SpellConfig("self", "rapid", 6_000, 12_000),
    "minus": SpellConfig("opponent", "slow", 5_000, 12_000),
    "circle": SpellConfig("self", "shield", 4_000, 14_000),
    "star": SpellConfig("opponent", "blind", 2_250, 15_000),
    "triangle": SpellConfig("self", "reflect", 4_000, 16_000),
    "loop": SpellConfig("self", None, 0, 5_000),
}


def _empty_effects() -> dict[EffectName, int]:
    return {effect: 0 for effect in EFFECT_NAMES}


def _empty_cooldowns() -> dict[SpellName, int]:
    return {spell: 0 for spell in SPELL_NAMES}


@dataclass(frozen=True)
class PlayerState:
    player_id: str
    health: int = MAX_HEALTH
    ammo: int = MAX_AMMO
    next_shot_at_ms: int = 0
    effects: dict[EffectName, int] = field(default_factory=_empty_effects)
    cooldowns: dict[SpellName, int] = field(default_factory=_empty_cooldowns)
    wants_rematch: bool = False


@dataclass(frozen=True)
class GameState:
    room_id: str
    players: dict[str, PlayerState]
    phase: GamePhase = "waiting"
    winner_id: str | None = None


@dataclass(frozen=True)
class ActionResult:
    state: GameState
    accepted: bool
    reason: str | None = None
    retry_after_ms: int | None = None
    event: dict[str, object] | None = None


def create_game(room_id: str, player_id: str) -> GameState:
    player = PlayerState(player_id=player_id)
    return GameState(room_id=room_id, players={player_id: player})


def add_player(state: GameState, player_id: str) -> ActionResult:
    if player_id in state.players:
        return ActionResult(state=state, accepted=True)
    if len(state.players) >= 2:
        return ActionResult(state=state, accepted=False, reason="room_full")

    players = dict(state.players)
    players[player_id] = PlayerState(player_id=player_id)
    return ActionResult(
        state=replace(state, players=players, phase="waiting"),
        accepted=True,
        event={"event": "player_joined", "source_player_id": player_id},
    )


def start_game(state: GameState) -> ActionResult:
    if state.phase != "waiting":
        return ActionResult(state, False, "game_not_waiting")
    if len(state.players) != 2:
        return ActionResult(state, False, "opponent_missing")
    return ActionResult(
        state=replace(state, phase="playing", winner_id=None),
        accepted=True,
        event={"event": "game_started"},
    )


def pause_game(state: GameState) -> GameState:
    if state.phase != "playing":
        return state
    return replace(state, phase="waiting")


def remove_player(state: GameState, player_id: str) -> ActionResult:
    if player_id not in state.players:
        return ActionResult(state, False, "unknown_player")

    remaining_ids = [
        current_id for current_id in state.players if current_id != player_id
    ]
    players = {
        current_id: PlayerState(player_id=current_id)
        for current_id in remaining_ids
    }
    return ActionResult(
        state=replace(
            state,
            players=players,
            phase="waiting",
            winner_id=None,
        ),
        accepted=True,
        event={"event": "player_left", "source_player_id": player_id},
    )


def effect_is_active(
    player: PlayerState, effect: EffectName, now_ms: int
) -> bool:
    return player.effects[effect] > now_ms


def shot_interval_ms(player: PlayerState, now_ms: int) -> int:
    rapid = effect_is_active(player, "rapid", now_ms)
    slow = effect_is_active(player, "slow", now_ms)
    if rapid and not slow:
        return RAPID_SHOT_INTERVAL_MS
    if slow and not rapid:
        return SLOW_SHOT_INTERVAL_MS
    return BASE_SHOT_INTERVAL_MS


def cast_spell(
    state: GameState,
    player_id: str,
    spell: str,
    now_ms: int,
) -> ActionResult:
    actor = state.players.get(player_id)
    if actor is None:
        return ActionResult(state, False, "unknown_player")
    if state.phase != "playing":
        return ActionResult(state, False, "game_not_active")
    if actor.health <= 0:
        return ActionResult(state, False, "player_defeated")
    if spell not in SPELLS:
        return ActionResult(state, False, "unsupported_spell")

    spell_name = cast(SpellName, spell)
    config = SPELLS[spell_name]
    ready_at = actor.cooldowns[spell_name]
    if ready_at > now_ms:
        return ActionResult(
            state,
            False,
            "spell_cooldown",
            retry_after_ms=ready_at - now_ms,
        )
    if spell_name == "loop" and actor.ammo == MAX_AMMO:
        return ActionResult(state, False, "ammo_full")

    players = dict(state.players)
    updated_cooldowns = dict(actor.cooldowns)
    updated_cooldowns[spell_name] = now_ms + config.cooldown_ms
    updated_actor = replace(actor, cooldowns=updated_cooldowns)

    target_id = (
        player_id if config.target == "self" else _opponent_id(state, player_id)
    )
    if target_id is None:
        return ActionResult(state, False, "opponent_missing")

    if spell_name == "loop":
        updated_actor = replace(updated_actor, ammo=MAX_AMMO)
        players[player_id] = updated_actor
    else:
        target = updated_actor if target_id == player_id else players[target_id]
        effects = dict(target.effects)
        if config.effect is not None:
            effects[config.effect] = now_ms + config.duration_ms
        updated_target = replace(target, effects=effects)
        players[player_id] = (
            updated_target if target_id == player_id else updated_actor
        )
        players[target_id] = updated_target

    return ActionResult(
        state=replace(state, players=players),
        accepted=True,
        event={
            "event": "spell_cast",
            "source_player_id": player_id,
            "target_player_id": target_id,
            "spell": spell_name,
            "effect": config.effect,
            "duration_ms": config.duration_ms,
        },
    )


def fire(
    state: GameState,
    player_id: str,
    now_ms: int,
    target_locked: bool = True,
) -> ActionResult:
    actor = state.players.get(player_id)
    if actor is None:
        return ActionResult(state, False, "unknown_player")
    if state.phase != "playing":
        return ActionResult(state, False, "game_not_active")
    if actor.health <= 0:
        return ActionResult(state, False, "player_defeated")
    if actor.ammo <= 0:
        return ActionResult(state, False, "out_of_ammo")
    if actor.next_shot_at_ms > now_ms:
        return ActionResult(
            state,
            False,
            "fire_rate_limited",
            retry_after_ms=actor.next_shot_at_ms - now_ms,
        )

    target_id = _opponent_id(state, player_id)
    if target_id is None:
        return ActionResult(state, False, "opponent_missing")

    target = state.players[target_id]
    players = dict(state.players)
    updated_actor = replace(
        actor,
        ammo=actor.ammo - 1,
        next_shot_at_ms=now_ms + shot_interval_ms(actor, now_ms),
    )
    updated_target = target
    outcome: Literal["hit", "blocked", "reflected", "missed"]
    damage = 0
    winner_id: str | None = None
    phase: GamePhase = state.phase

    if not target_locked:
        outcome = "missed"
    elif effect_is_active(target, "reflect", now_ms):
        outcome = "reflected"
        damage = SHOT_DAMAGE
        updated_actor = replace(
            updated_actor, health=max(0, updated_actor.health - SHOT_DAMAGE)
        )
        if updated_actor.health == 0:
            phase = "finished"
            winner_id = target_id
    elif effect_is_active(target, "shield", now_ms):
        outcome = "blocked"
    else:
        outcome = "hit"
        damage = SHOT_DAMAGE
        updated_target = replace(
            target, health=max(0, target.health - SHOT_DAMAGE)
        )
        if updated_target.health == 0:
            phase = "finished"
            winner_id = player_id

    players[player_id] = updated_actor
    players[target_id] = updated_target
    return ActionResult(
        state=replace(
            state,
            players=players,
            phase=phase,
            winner_id=winner_id,
        ),
        accepted=True,
        event={
            "event": "shot",
            "source_player_id": player_id,
            "target_player_id": target_id,
            "damaged_player_id": (
                player_id if outcome == "reflected" else target_id
                if outcome == "hit"
                else None
            ),
            "outcome": outcome,
            "damage": damage,
        },
    )


def request_rematch(
    state: GameState, player_id: str
) -> ActionResult:
    actor = state.players.get(player_id)
    if actor is None:
        return ActionResult(state, False, "unknown_player")
    if state.phase != "finished":
        return ActionResult(state, False, "game_not_finished")
    if actor.wants_rematch:
        return ActionResult(state, False, "rematch_already_requested")

    players = dict(state.players)
    players[player_id] = replace(actor, wants_rematch=True)
    if len(players) == 2 and all(player.wants_rematch for player in players.values()):
        reset_players = {
            current_id: PlayerState(player_id=current_id) for current_id in players
        }
        return ActionResult(
            state=replace(
                state,
                players=reset_players,
                phase="waiting",
                winner_id=None,
            ),
            accepted=True,
            event={"event": "rematch_started", "source_player_id": player_id},
        )

    return ActionResult(
        state=replace(state, players=players),
        accepted=True,
        event={"event": "rematch_requested", "source_player_id": player_id},
    )


def _opponent_id(state: GameState, player_id: str) -> str | None:
    return next(
        (current_id for current_id in state.players if current_id != player_id),
        None,
    )
