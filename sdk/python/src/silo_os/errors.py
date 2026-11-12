"""Errors raised by the SILO client. All of them are SiloError."""
from __future__ import annotations

from typing import Any, Optional


class SiloError(Exception):
    """SILO refused the request or could not be reached. status is the HTTP status, or 0 without an answer."""

    def __init__(self, message: str, status: int = 0, body: Any = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body


class ConnectionFailed(SiloError):
    """SILO did not answer: wrong address, not running, or the network is down."""


class AuthError(SiloError):
    """401: the token is missing, wrong, expired or revoked."""


class PermissionDenied(SiloError):
    """403: the token lacks the scope, or its person's role does not allow this."""


class NotFound(SiloError):
    """404: no such resident, workflow, run or report, or the feature is off."""


class Conflict(SiloError):
    """409: SILO is busy with it (a run already going, tests already running) or it was already decided."""


class RateLimited(SiloError):
    """429: too many requests with this token. retry_after is in seconds."""

    def __init__(self, message: str, status: int = 429, body: Any = None, retry_after: Optional[float] = None) -> None:
        super().__init__(message, status, body)
        self.retry_after = retry_after


class ServerError(SiloError):
    """5xx: SILO failed while doing it."""


class Timeout(SiloError):
    """A wait (for a run or a test report) took longer than its timeout. The work may still be going on in SILO."""


def error_for(status: int, message: str, body: Any = None, retry_after: Optional[float] = None) -> SiloError:
    if status == 401:
        return AuthError(message, status, body)
    if status == 403:
        return PermissionDenied(message, status, body)
    if status == 404:
        return NotFound(message, status, body)
    if status == 409:
        return Conflict(message, status, body)
    if status == 429:
        return RateLimited(message, status, body, retry_after)
    if status >= 500:
        return ServerError(message, status, body)
    return SiloError(message, status, body)
