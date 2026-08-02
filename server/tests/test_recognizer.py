from math import cos, pi, sin

import pytest

from app.recognizer import recognizer


def circle_points() -> list[tuple[float, float]]:
    return [
        (
            0.48 + 0.29 * cos(0.12 + 2 * pi * index / 20),
            0.52 + 0.32 * sin(0.12 + 2 * pi * index / 20),
        )
        for index in range(21)
    ]


def star_points() -> list[tuple[float, float]]:
    vertices = [
        (
            0.52 + 0.31 * cos(-pi / 2 + 2 * pi * index / 5),
            0.48 + 0.31 * sin(-pi / 2 + 2 * pi * index / 5),
        )
        for index in range(5)
    ]
    return [vertices[index] for index in (0, 2, 4, 1, 3, 0)]


def up_arrow_strokes() -> list[list[tuple[float, float]]]:
    return [
        [(0.50, 0.84), (0.50, 0.16)],
        [(0.20, 0.44), (0.50, 0.16), (0.80, 0.44)],
    ]


def old_reload_loop_points() -> list[tuple[float, float]]:
    loop = [
        (
            0.44 + 0.28 * cos(pi / 4 + 2 * pi * index / 24),
            0.39 + 0.28 * sin(pi / 4 + 2 * pi * index / 24),
        )
        for index in range(25)
    ]
    return [*loop, (0.78, 0.68), (0.86, 0.78)]


@pytest.mark.parametrize(
    ("drawing_type", "strokes"),
    [
        (
            "plus",
            [
                [(0.48, 0.18), (0.51, 0.83)],
                [(0.82, 0.49), (0.17, 0.52)],
            ],
        ),
        ("minus", [[(0.16, 0.51), (0.84, 0.49)]]),
        ("circle", [circle_points()]),
        ("star", [star_points()]),
        (
            "triangle",
            [[(0.50, 0.15), (0.84, 0.80), (0.16, 0.80), (0.50, 0.15)]],
        ),
        ("loop", up_arrow_strokes()),
    ],
)
def test_recognizes_supported_drawings(
    drawing_type: str, strokes: list[list[tuple[float, float]]]
) -> None:
    result = recognizer.recognize(strokes)

    assert result.accepted is True
    assert result.drawing_type == drawing_type
    assert result.score > 0.9


@pytest.mark.parametrize("drawing_type", ["circle", "star", "triangle", "loop"])
def test_corrects_portrait_canvas_aspect_ratio(drawing_type: str) -> None:
    width = 390
    height = 844
    if drawing_type == "circle":
        pixel_strokes = [
            [
                (
                    195 + 120 * cos(2 * pi * index / 32),
                    360 + 120 * sin(2 * pi * index / 32),
                )
                for index in range(33)
            ]
        ]
    elif drawing_type == "star":
        vertices = [
            (
                195 + 130 * cos(-pi / 2 + 2 * pi * index / 5),
                360 + 130 * sin(-pi / 2 + 2 * pi * index / 5),
            )
            for index in range(5)
        ]
        pixel_strokes = [[vertices[index] for index in (0, 2, 4, 1, 3, 0)]]
    elif drawing_type == "triangle":
        pixel_strokes = [[(195, 220), (325, 500), (65, 500), (195, 220)]]
    else:
        pixel_strokes = [
            [(195, 510), (195, 210)],
            [(65, 340), (195, 210), (325, 340)],
        ]

    normalized_strokes = [
        [(x / width, y / height) for x, y in stroke]
        for stroke in pixel_strokes
    ]

    result = recognizer.recognize(
        normalized_strokes, aspect_ratio=width / height
    )

    assert result.accepted is True
    assert result.drawing_type == drawing_type


def test_old_reload_loop_does_not_reload() -> None:
    result = recognizer.recognize([old_reload_loop_points()])

    assert result.drawing_type != "loop"


@pytest.mark.parametrize(
    "strokes",
    [
        [[(0.1, 0.1), (0.9, 0.9)]],
        [[(0.1, 0.1), (0.8, 0.2), (0.2, 0.4), (0.9, 0.6), (0.1, 0.9)]],
        [[(0.5, 0.5)]],
        [[(0.2, 0.2), (0.8, 0.2), (0.8, 0.8), (0.2, 0.8), (0.2, 0.2)]],
        [[(0.2, 0.2), (0.2, 0.8), (0.5, 0.9), (0.8, 0.8), (0.8, 0.2)]],
        [
            [
                (0.8, 0.5),
                (0.75, 0.25),
                (0.5, 0.18),
                (0.25, 0.25),
                (0.18, 0.5),
                (0.25, 0.75),
                (0.5, 0.82),
            ]
        ],
    ],
)
def test_rejects_unsupported_drawings(
    strokes: list[list[tuple[float, float]]],
) -> None:
    result = recognizer.recognize(strokes)

    assert result.accepted is False
    assert result.drawing_type is None
    assert result.reason in {"ambiguous", "invalid_drawing", "no_match"}
