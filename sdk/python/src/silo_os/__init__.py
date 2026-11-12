"""silo-os: the Python client for SILO.

    from silo_os import Silo
    silo = Silo()                                   # SILO_URL and SILO_TOKEN from the environment
    print(silo.ask("Atlas", "What changed today?").text)
    run = silo.run("Invoice reader", "invoice-0042.pdf")
    report = silo.evaluate("Invoice reader")        # report["worse"] is True on a regression
"""
from .client import DEFAULT_URL, Answer, AsyncSilo, Silo
from .errors import (AuthError, Conflict, ConnectionFailed, NotFound, PermissionDenied, RateLimited, ServerError,
                     SiloError, Timeout)

__version__ = "0.1.0"
__all__ = ["Silo", "AsyncSilo", "Answer", "DEFAULT_URL", "SiloError", "ConnectionFailed", "AuthError",
           "PermissionDenied", "NotFound", "Conflict", "RateLimited", "ServerError", "Timeout", "__version__"]
