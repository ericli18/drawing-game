from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]
    y: Annotated[float, Field(ge=0.0, le=1.0, allow_inf_nan=False)]


Stroke = Annotated[list[Point], Field(min_length=1, max_length=2048)]


class CastMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["cast"]
    strokes: Annotated[list[Stroke], Field(min_length=1, max_length=8)]
    aspect_ratio: float = Field(
        default=1.0,
        alias="aspectRatio",
        gt=0.0,
        le=10.0,
        allow_inf_nan=False,
    )


class FireMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["fire"]
    target_locked: bool = Field(alias="targetLocked")


class RematchMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["rematch"]


class ReadyMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["ready"]
    ready: bool


class LeaveMessage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["leave"]


ClientMessage = Annotated[
    CastMessage | FireMessage | RematchMessage | ReadyMessage | LeaveMessage,
    Field(discriminator="type"),
]
client_message_adapter = TypeAdapter(ClientMessage)
