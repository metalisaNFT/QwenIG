import base64
import binascii
import io
from typing import Literal
from PIL import Image
from pydantic import BaseModel, Field, field_validator, model_validator


def validate_image_data(value: str, message: str) -> tuple[int, int]:
    """Accept only an embedded PNG/JPEG/WebP data URL within the service's size limits."""
    try:
        if len(value) > 12 * 1024 * 1024:
            raise ValueError()
        header, encoded = value.split(',', 1)
        if header not in ('data:image/png;base64', 'data:image/jpeg;base64', 'data:image/webp;base64'):
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 8 * 1024 * 1024:
            raise ValueError()
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in ('PNG', 'JPEG', 'WEBP') or max(image.size) > 4096 or image.width * image.height > 16_000_000:
                raise ValueError()
            size = image.size
            image.verify()
        return size
    except (ValueError, OSError, SyntaxError, binascii.Error, Image.DecompressionBombError):
        raise ValueError(message) from None


def decode_image_data(value: str) -> Image.Image:
    """Decode a data URL already accepted by validate_image_data."""
    image = Image.open(io.BytesIO(base64.b64decode(value.split(',', 1)[1])))
    image.load()
    return image


class GenerateRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    negative_prompt: str = Field(default="", max_length=20000)
    width: int = Field(default=1024, ge=256, le=2048)
    height: int = Field(default=1024, ge=256, le=2048)
    steps: int = Field(default=28, ge=1, le=100)
    guidance: float = Field(default=6, ge=0, le=20)
    seed: int = Field(default=-1, ge=-1, le=2147483647)
    reference_images: list[str] = Field(default_factory=list, max_length=3)
    transparent: bool = False  # RGBA output with a transparent background (Qwen-Image 2.1)

    @field_validator("reference_images")
    @classmethod
    def valid_references(cls, values):
        for value in values:
            validate_image_data(value, "Use a valid PNG, JPEG or WebP reference under 8 MB and 4096 pixels per side")
        return values

    @field_validator("prompt")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("Prompt cannot be blank")
        return value.strip()

    @field_validator("width", "height")
    @classmethod
    def alignment(cls, value):
        if value % 32:
            raise ValueError("Dimensions must be divisible by 32")
        return value


class RemoveBackgroundRequest(BaseModel):
    """One image for salient-subject matting. The result is a grayscale mask of the same size."""
    image: str

    @field_validator("image")
    @classmethod
    def valid_image(cls, value):
        validate_image_data(value, "Send a valid PNG, JPEG or WebP image under 8 MB and 4096 pixels per side")
        return value


EDIT_OPERATIONS = ("edit", "inpaint", "outpaint", "image-to-image", "variations")


class EditRequest(GenerateRequest):
    """Edit one image. The studio sends the source (and mask) already sized to width × height.

    edit: instruction edit of the whole image (reference conditioning; needs the vision encoder).
    inpaint / outpaint: regenerate the white area of `mask`, keep the black area.
    image-to-image / variations: re-imagine the whole image; `strength` sets how far it may move.
    """
    operation: Literal["edit", "inpaint", "outpaint", "image-to-image", "variations"]
    image: str
    mask: str | None = None
    strength: float | None = Field(default=None, ge=0.05, le=1)

    @field_validator("image")
    @classmethod
    def valid_image(cls, value):
        validate_image_data(value, "Send a valid PNG, JPEG or WebP source image under 8 MB and 4096 pixels per side")
        return value

    @field_validator("mask")
    @classmethod
    def valid_mask(cls, value):
        if value is not None:
            validate_image_data(value, "Send a valid PNG mask under 8 MB and 4096 pixels per side")
        return value

    @model_validator(mode="after")
    def consistent(self):
        if self.operation in ("inpaint", "outpaint") and not self.mask:
            raise ValueError(f"{self.operation} needs a mask (white = area to regenerate)")
        if len(self.reference_images) > 2:
            raise ValueError("Use up to two extra reference images with an edit")
        for value, label in ((self.image, "source image"), (self.mask, "mask")):
            if value is not None and validate_image_data(value, "invalid") != (self.width, self.height):
                raise ValueError(f"The {label} must be exactly {self.width} × {self.height} pixels")
        return self

    @property
    def effective_strength(self) -> float:
        if self.strength is not None:
            return self.strength
        return {"image-to-image": .6, "variations": .45}.get(self.operation, 1.0)


class VideoRequest(BaseModel):
    """Text- or image-to-video. Frames follow the 8n + 1 rule of the LTX video VAE."""
    prompt: str = Field(min_length=1, max_length=20000)
    negative_prompt: str = Field(default="worst quality, low quality, blurry, distorted, artifacts", max_length=20000)
    width: int = Field(default=768, ge=256, le=1920)
    height: int = Field(default=512, ge=256, le=1920)
    frames: int = Field(default=97, ge=9, le=257)
    fps: int = Field(default=24, ge=8, le=50)
    steps: int = Field(default=8, ge=1, le=100)
    guidance: float = Field(default=1, ge=0, le=20)
    seed: int = Field(default=-1, ge=-1, le=2147483647)
    image: str | None = None
    end_image: str | None = None

    @field_validator("prompt")
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError("Prompt cannot be blank")
        return value.strip()

    @field_validator("width", "height")
    @classmethod
    def alignment(cls, value):
        if value % 32:
            raise ValueError("Video dimensions must be divisible by 32")
        return value

    @field_validator("frames")
    @classmethod
    def frame_rule(cls, value):
        if (value - 1) % 8:
            raise ValueError("Frame count must be 8n + 1 (for example 49, 97 or 121)")
        return value

    @field_validator("image", "end_image")
    @classmethod
    def valid_frame(cls, value):
        if value is not None:
            validate_image_data(value, "Send a valid PNG, JPEG or WebP frame under 8 MB and 4096 pixels per side")
        return value


# Audio and language ---------------------------------------------------------------------
AUDIO_TYPES = ("audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a",
               "audio/aac", "audio/ogg", "audio/webm", "audio/flac", "audio/x-flac", "video/mp4", "video/webm",
               "video/quicktime")
AUDIO_LIMIT = 32 * 1024 * 1024


def validate_audio_data(value: str, message: str) -> int:
    """Accept an embedded audio (or video with sound) data URL; returns its decoded size."""
    try:
        if len(value) > AUDIO_LIMIT * 4 // 3 + 128:
            raise ValueError()
        header, encoded = value.split(",", 1)
        if not header.endswith(";base64"):
            raise ValueError()
        media = header[5:-7].split(";")[0].lower()
        if not header.startswith("data:") or media not in AUDIO_TYPES:
            raise ValueError()
        data = base64.b64decode(encoded, validate=True)
        if not 64 <= len(data) <= AUDIO_LIMIT:
            raise ValueError()
        return len(data)
    except (ValueError, binascii.Error):
        raise ValueError(message) from None


def decode_audio_data(value: str) -> bytes:
    return base64.b64decode(value.split(",", 1)[1])


def _text(value: str, label: str) -> str:
    if not value.strip():
        raise ValueError(f"{label} cannot be blank")
    return value.strip()


class TranscribeRequest(BaseModel):
    """Audio or a video with sound; the result is text with timed segments."""
    audio: str
    language: str | None = Field(default=None, min_length=2, max_length=5, pattern=r"^[a-z]{2,3}(-[a-z]{2})?$")

    @field_validator("audio")
    @classmethod
    def valid_audio(cls, value):
        validate_audio_data(value, "Send a WAV, MP3, M4A, OGG, WebM, FLAC or MP4 file under 32 MB")
        return value


class DescribeRequest(BaseModel):
    """Describe an image as a prompt (to recreate or animate it) or as a plain caption."""
    image: str
    purpose: Literal["image", "video", "caption"] = "image"

    @field_validator("image")
    @classmethod
    def valid_image(cls, value):
        validate_image_data(value, "Send a valid PNG, JPEG or WebP image under 8 MB and 4096 pixels per side")
        return value


class EnhancePromptRequest(BaseModel):
    """Rewrite a short idea into a detailed prompt for one of the studio's generators."""
    prompt: str = Field(min_length=1, max_length=4000)
    target: Literal["image", "edit", "video", "music"] = "image"

    @field_validator("prompt")
    @classmethod
    def nonempty(cls, value):
        return _text(value, "Prompt")


class SpeechRequest(BaseModel):
    """Text to speech. `voice` is an optional reference clip (over 5 seconds) whose voice is cloned."""
    text: str = Field(min_length=1, max_length=5000)
    voice: str | None = None
    temperature: float = Field(default=0.8, ge=0.05, le=2)
    seed: int = Field(default=-1, ge=-1, le=2147483647)

    @field_validator("text")
    @classmethod
    def nonempty(cls, value):
        return _text(value, "Text")

    @field_validator("voice")
    @classmethod
    def valid_voice(cls, value):
        if value is not None:
            validate_audio_data(value, "Send the voice sample as a WAV, MP3, M4A, OGG, WebM or FLAC file under 32 MB")
        return value


class MusicRequest(BaseModel):
    """A song from a style description and optional lyrics with [verse]/[chorus] tags on their own lines."""
    style: str = Field(min_length=1, max_length=2000)
    lyrics: str = Field(default="", max_length=3500)
    duration: int = Field(default=60, ge=10, le=300)
    instrumental: bool = False
    seed: int = Field(default=-1, ge=-1, le=2147483647)

    @field_validator("style")
    @classmethod
    def nonempty(cls, value):
        return _text(value, "Style")

    @model_validator(mode="after")
    def lyrics_or_instrumental(self):
        if not self.instrumental and not self.lyrics.strip():
            raise ValueError("Add lyrics, or choose instrumental")
        return self


class UpscaleRequest(BaseModel):
    """Upscale one image ×2 or ×4 (output up to 8192 pixels per side)."""
    image: str
    scale: Literal[2, 4] = 2

    @field_validator("image")
    @classmethod
    def valid_image(cls, value):
        validate_image_data(value, "Send a valid PNG, JPEG or WebP image under 8 MB and 4096 pixels per side")
        return value

    @property
    def source_size(self) -> tuple[int, int]:
        return validate_image_data(self.image, "invalid")


class DetectPoseRequest(BaseModel):
    """Find people and their body pose (OpenPose-18 keypoints) in one image."""
    image: str

    @field_validator("image")
    @classmethod
    def valid_image(cls, value):
        validate_image_data(value, "Send a valid PNG, JPEG or WebP image under 8 MB and 4096 pixels per side")
        return value
