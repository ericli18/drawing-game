from __future__ import annotations

from dataclasses import dataclass, replace
from math import cos, floor, hypot, pi, sin, sqrt
from typing import Iterable, Sequence


SAMPLE_COUNT = 32
MAX_INT_COORD = 1024
LUT_SIZE = 64
LUT_SCALE_FACTOR = MAX_INT_COORD / LUT_SIZE
MAX_NORMALIZED_DISTANCE = 0.1
MIN_CLASS_MARGIN = 0.025


@dataclass(frozen=True)
class GesturePoint:
    x: float
    y: float
    stroke_id: int
    int_x: int = 0
    int_y: int = 0


@dataclass(frozen=True)
class RecognitionResult:
    accepted: bool
    drawing_type: str | None
    score: float
    reason: str | None = None


class PointCloud:
    def __init__(self, name: str, strokes: Sequence[Sequence[tuple[float, float]]]):
        points = _flatten_strokes(strokes)
        if _path_length(points) <= 1e-6:
            raise ValueError("Drawing must contain a visible path")

        self.name = name
        self.points = _make_int_coords(
            _translate_to_origin(_scale(_resample(points, SAMPLE_COUNT)))
        )
        self.lookup_table = _compute_lookup_table(self.points)


class QDollarRecognizer:
    """A small server-side port of the $Q point-cloud recognizer."""

    def __init__(self, templates: Sequence[PointCloud]):
        self.templates = templates

    def recognize(
        self,
        strokes: Sequence[Sequence[tuple[float, float]]],
        aspect_ratio: float = 1.0,
    ) -> RecognitionResult:
        corrected_strokes = [
            [(x * aspect_ratio, y) for x, y in stroke] for stroke in strokes
        ]
        try:
            candidate = PointCloud("candidate", corrected_strokes)
        except (IndexError, ValueError):
            return RecognitionResult(False, None, 0.0, "invalid_drawing")

        distances_by_class: dict[str, float] = {}
        for template in self.templates:
            distance = _cloud_match(candidate, template, float("inf"))
            current = distances_by_class.get(template.name, float("inf"))
            distances_by_class[template.name] = min(current, distance)

        ranked = sorted(distances_by_class.items(), key=lambda item: item[1])
        best_name, best_raw_distance = ranked[0]
        second_raw_distance = ranked[1][1]
        best_distance = _normalized_distance(best_raw_distance)
        second_distance = _normalized_distance(second_raw_distance)
        score = round(max(0.0, 1.0 - best_distance), 4)

        if best_distance > MAX_NORMALIZED_DISTANCE:
            return RecognitionResult(False, None, score, "no_match")
        if second_distance - best_distance < MIN_CLASS_MARGIN:
            return RecognitionResult(False, None, score, "ambiguous")
        return RecognitionResult(True, best_name, score)


def _normalized_distance(raw_distance: float) -> float:
    weight_sum = SAMPLE_COUNT * (SAMPLE_COUNT + 1) / 2
    return sqrt(raw_distance / weight_sum)


def _flatten_strokes(
    strokes: Sequence[Sequence[tuple[float, float]]],
) -> list[GesturePoint]:
    return [
        GesturePoint(x, y, stroke_id)
        for stroke_id, stroke in enumerate(strokes, start=1)
        for x, y in stroke
    ]


def _resample(points: Sequence[GesturePoint], count: int) -> list[GesturePoint]:
    working = list(points)
    interval = _path_length(working) / (count - 1)
    distance_since_sample = 0.0
    sampled = [working[0]]
    index = 1

    while index < len(working):
        previous = working[index - 1]
        current = working[index]
        if current.stroke_id == previous.stroke_id:
            distance = _distance(previous, current)
            if distance > 0 and distance_since_sample + distance >= interval:
                ratio = (interval - distance_since_sample) / distance
                point = GesturePoint(
                    previous.x + ratio * (current.x - previous.x),
                    previous.y + ratio * (current.y - previous.y),
                    current.stroke_id,
                )
                sampled.append(point)
                working.insert(index, point)
                distance_since_sample = 0.0
            else:
                distance_since_sample += distance
        index += 1

    if len(sampled) < count:
        sampled.extend([working[-1]] * (count - len(sampled)))
    return sampled[:count]


def _scale(points: Sequence[GesturePoint]) -> list[GesturePoint]:
    min_x = min(point.x for point in points)
    max_x = max(point.x for point in points)
    min_y = min(point.y for point in points)
    max_y = max(point.y for point in points)
    size = max(max_x - min_x, max_y - min_y)
    if size <= 1e-6:
        raise ValueError("Drawing must have non-zero size")
    return [
        replace(point, x=(point.x - min_x) / size, y=(point.y - min_y) / size)
        for point in points
    ]


def _translate_to_origin(points: Sequence[GesturePoint]) -> list[GesturePoint]:
    center_x = sum(point.x for point in points) / len(points)
    center_y = sum(point.y for point in points) / len(points)
    return [
        replace(point, x=point.x - center_x, y=point.y - center_y)
        for point in points
    ]


def _make_int_coords(points: Sequence[GesturePoint]) -> list[GesturePoint]:
    return [
        replace(
            point,
            int_x=round((point.x + 1.0) / 2.0 * (MAX_INT_COORD - 1)),
            int_y=round((point.y + 1.0) / 2.0 * (MAX_INT_COORD - 1)),
        )
        for point in points
    ]


def _compute_lookup_table(points: Sequence[GesturePoint]) -> list[list[int]]:
    table = [[0] * LUT_SIZE for _ in range(LUT_SIZE)]
    integer_points = [
        (
            round(point.int_x / LUT_SCALE_FACTOR),
            round(point.int_y / LUT_SCALE_FACTOR),
        )
        for point in points
    ]
    for x in range(LUT_SIZE):
        for y in range(LUT_SIZE):
            table[x][y] = min(
                range(len(points)),
                key=lambda index: (integer_points[index][0] - x) ** 2
                + (integer_points[index][1] - y) ** 2,
            )
    return table


def _cloud_match(candidate: PointCloud, template: PointCloud, minimum: float) -> float:
    step = floor(sqrt(SAMPLE_COUNT))
    lower_bound_1 = _compute_lower_bound(
        candidate.points, template.points, step, template.lookup_table
    )
    lower_bound_2 = _compute_lower_bound(
        template.points, candidate.points, step, candidate.lookup_table
    )

    for bound_index, start in enumerate(range(0, SAMPLE_COUNT, step)):
        if lower_bound_1[bound_index] < minimum:
            minimum = min(
                minimum,
                _cloud_distance(candidate.points, template.points, start, minimum),
            )
        if lower_bound_2[bound_index] < minimum:
            minimum = min(
                minimum,
                _cloud_distance(template.points, candidate.points, start, minimum),
            )
    return minimum


def _cloud_distance(
    points: Sequence[GesturePoint],
    template: Sequence[GesturePoint],
    start: int,
    minimum_so_far: float,
) -> float:
    unmatched = list(range(SAMPLE_COUNT))
    point_index = start
    weight = SAMPLE_COUNT
    total = 0.0

    while True:
        unmatched_index = min(
            range(len(unmatched)),
            key=lambda index: _squared_distance(
                points[point_index], template[unmatched[index]]
            ),
        )
        template_index = unmatched.pop(unmatched_index)
        total += weight * _squared_distance(
            points[point_index], template[template_index]
        )
        if total >= minimum_so_far:
            return total
        weight -= 1
        point_index = (point_index + 1) % SAMPLE_COUNT
        if point_index == start:
            return total


def _compute_lower_bound(
    points: Sequence[GesturePoint],
    template: Sequence[GesturePoint],
    step: int,
    lookup_table: Sequence[Sequence[int]],
) -> list[float]:
    lower_bounds = [0.0] * (SAMPLE_COUNT // step + 1)
    summed_area_table = [0.0] * SAMPLE_COUNT

    for index, point in enumerate(points):
        x = min(LUT_SIZE - 1, round(point.int_x / LUT_SCALE_FACTOR))
        y = min(LUT_SIZE - 1, round(point.int_y / LUT_SCALE_FACTOR))
        distance = _squared_distance(point, template[lookup_table[x][y]])
        summed_area_table[index] = distance
        if index > 0:
            summed_area_table[index] += summed_area_table[index - 1]
        lower_bounds[0] += (SAMPLE_COUNT - index) * distance

    for bound_index, index in enumerate(
        range(step, SAMPLE_COUNT, step), start=1
    ):
        lower_bounds[bound_index] = (
            lower_bounds[0]
            + index * summed_area_table[-1]
            - SAMPLE_COUNT * summed_area_table[index - 1]
        )
    return lower_bounds


def _path_length(points: Sequence[GesturePoint]) -> float:
    return sum(
        _distance(previous, current)
        for previous, current in zip(points, points[1:])
        if previous.stroke_id == current.stroke_id
    )


def _distance(first: GesturePoint, second: GesturePoint) -> float:
    return hypot(second.x - first.x, second.y - first.y)


def _squared_distance(first: GesturePoint, second: GesturePoint) -> float:
    return (second.x - first.x) ** 2 + (second.y - first.y) ** 2


def _line(
    start: tuple[float, float], end: tuple[float, float], count: int = 8
) -> list[tuple[float, float]]:
    return [
        (
            start[0] + (end[0] - start[0]) * index / (count - 1),
            start[1] + (end[1] - start[1]) * index / (count - 1),
        )
        for index in range(count)
    ]


def _circle(
    center: tuple[float, float], radii: tuple[float, float], phase: float = 0.0
) -> list[tuple[float, float]]:
    return [
        (
            center[0] + radii[0] * cos(phase + 2 * pi * index / 24),
            center[1] + radii[1] * sin(phase + 2 * pi * index / 24),
        )
        for index in range(25)
    ]


def _star(
    center: tuple[float, float], radius: float, rotation: float = -pi / 2
) -> list[tuple[float, float]]:
    vertices = [
        (
            center[0] + radius * cos(rotation + 2 * pi * index / 5),
            center[1] + radius * sin(rotation + 2 * pi * index / 5),
        )
        for index in range(5)
    ]
    order = (0, 2, 4, 1, 3, 0)
    return [vertices[index] for index in order]


def _triangle(
    top: tuple[float, float],
    bottom_right: tuple[float, float],
    bottom_left: tuple[float, float],
) -> list[tuple[float, float]]:
    return [top, bottom_right, bottom_left, top]


def _lasso(
    center: tuple[float, float],
    radii: tuple[float, float],
    phase: float,
    tail_end: tuple[float, float],
) -> list[tuple[float, float]]:
    loop = _circle(center, radii, phase)
    return [*loop, *_line(loop[-1], tail_end, count=4)[1:]]


def _templates() -> Iterable[PointCloud]:
    pluses = (
        (((0.50, 0.18), (0.50, 0.82)), ((0.18, 0.50), (0.82, 0.50))),
        (((0.48, 0.16), (0.51, 0.84)), ((0.16, 0.52), (0.83, 0.49))),
        (((0.52, 0.20), (0.49, 0.81)), ((0.21, 0.48), (0.79, 0.52))),
        (((0.49, 0.14), (0.52, 0.86)), ((0.14, 0.49), (0.86, 0.51))),
        (((0.51, 0.19), (0.48, 0.80)), ((0.19, 0.53), (0.81, 0.47))),
    )
    for vertical, horizontal in pluses:
        yield PointCloud("plus", (_line(*vertical), _line(*horizontal)))

    minuses = (
        ((0.16, 0.50), (0.84, 0.50)),
        ((0.15, 0.48), (0.85, 0.52)),
        ((0.18, 0.52), (0.82, 0.48)),
        ((0.14, 0.51), (0.86, 0.49)),
        ((0.20, 0.49), (0.80, 0.51)),
    )
    for start, end in minuses:
        yield PointCloud("minus", (_line(start, end),))

    circles = (
        ((0.50, 0.50), (0.32, 0.32), 0.00),
        ((0.49, 0.51), (0.31, 0.33), 0.08),
        ((0.51, 0.49), (0.33, 0.30), -0.10),
        ((0.50, 0.50), (0.30, 0.34), 0.15),
        ((0.48, 0.50), (0.34, 0.31), -0.16),
    )
    for center, radii, phase in circles:
        yield PointCloud("circle", (_circle(center, radii, phase),))

    stars = (
        ((0.50, 0.50), 0.34, -pi / 2),
        ((0.49, 0.51), 0.33, -pi / 2 + 0.06),
        ((0.51, 0.50), 0.35, -pi / 2 - 0.07),
        ((0.50, 0.49), 0.32, -pi / 2 + 0.11),
        ((0.48, 0.50), 0.34, -pi / 2 - 0.12),
    )
    for center, radius, rotation in stars:
        yield PointCloud("star", (_star(center, radius, rotation),))

    triangles = (
        ((0.50, 0.15), (0.84, 0.80), (0.16, 0.80)),
        ((0.49, 0.16), (0.83, 0.82), (0.17, 0.79)),
        ((0.52, 0.14), (0.86, 0.79), (0.18, 0.82)),
        ((0.48, 0.18), (0.81, 0.83), (0.14, 0.78)),
        ((0.51, 0.17), (0.85, 0.81), (0.19, 0.80)),
    )
    for top, bottom_right, bottom_left in triangles:
        yield PointCloud("triangle", (_triangle(top, bottom_right, bottom_left),))

    lassos = (
        ((0.44, 0.39), (0.28, 0.28), pi / 4, (0.86, 0.78)),
        ((0.43, 0.40), (0.27, 0.29), pi / 4 + 0.06, (0.84, 0.80)),
        ((0.45, 0.38), (0.29, 0.27), pi / 4 - 0.05, (0.88, 0.76)),
        ((0.42, 0.41), (0.27, 0.27), pi / 4 + 0.10, (0.83, 0.82)),
        ((0.46, 0.40), (0.28, 0.29), pi / 4 - 0.09, (0.87, 0.81)),
    )
    for center, radii, phase, tail_end in lassos:
        yield PointCloud("loop", (_lasso(center, radii, phase, tail_end),))


recognizer = QDollarRecognizer(tuple(_templates()))
