"""Old name for the browserctrl package. Import `browserctrl` instead."""

import warnings

from browserctrl import *  # noqa: F401,F403
from browserctrl import BrowserCtrl, CDPError, ChromeCDP, find_stdio  # noqa: F401

warnings.warn("chrome_cdp is now called browserctrl; import browserctrl instead", DeprecationWarning, stacklevel=2)
