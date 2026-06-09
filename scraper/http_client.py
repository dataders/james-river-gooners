"""Shared HTTP session factory for the scrapers.

HiBid and Rasmus built byte-identical ``requests.Session`` objects (Chrome
User-Agent + Accept-Language), differing only in TLS verification — HiBid
occasionally serves a cert with a future not-before date during rotation, so it
turns verification off rather than hard-failing the whole run. :func:`make_session`
is that one factory.
"""

import warnings

import requests

# A current desktop-Chrome UA. The auction platforms gate some responses on a
# browser-like UA, so all three scrapers present the same one.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)


def make_session(*, verify: bool = True) -> requests.Session:
    """Return a configured ``requests.Session``.

    ``verify=False`` also silences urllib3's insecure-request warnings so a
    rotating cert doesn't spam the logs.
    """
    if not verify:
        import urllib3
        warnings.filterwarnings("ignore", message="Unverified HTTPS request")
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    session = requests.Session()
    session.headers.update({
        "User-Agent": BROWSER_USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
    })
    session.verify = verify
    return session
