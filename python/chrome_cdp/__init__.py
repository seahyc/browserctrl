"""Synchronous persistent browserctrl client. Add this package's parent to PYTHONPATH.

One Node sidecar per client, one shared daemon per explicitly selected browser.
A failed request is never retried. Inspect or reconnect explicitly after errors.
"""

import json
import warnings
import os
import queue
import subprocess
import threading
import time
from pathlib import Path


class CDPError(RuntimeError):
    pass


class ChromeCDP:
    def __init__(self, *, browser=None, port=None, timeout=30, env=None):
        if bool(browser) == bool(port):
            raise ValueError("Select exactly one browser or port")
        root = Path(__file__).resolve().parents[2]
        selector = ["--browser", browser] if browser else ["--port", str(port)]
        self.timeout = timeout
        self._lock = threading.Lock()
        self._id = 0
        self.last_warnings = []
        self._closed = False
        self._stdout_queue = queue.Queue()
        self._buffer = bytearray()
        self.process = subprocess.Popen(
            ["node", str(root / "bin/stdio.mjs"), *selector],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0, env={**os.environ, **(env or {})},
        )
        self._stdout_thread = threading.Thread(
            target=self._read_stdout, name="browserctrl-stdout", daemon=True,
        )
        self._stdout_thread.start()
        try:
            self.health()
        except Exception:
            self.close()
            raise

    def request(self, op, *, target=None, method=None, params=None, timeout=None):
        """Send once; any disconnect/timeout leaves outcome uncertain, never replayed."""
        with self._lock:
            if self._closed:
                raise CDPError("Client closed; create a new connection and observe before acting")
            self._id += 1
            duration = self.timeout if timeout is None else timeout
            message = {"id": self._id, "op": op, "target": target, "method": method,
                       "params": params or {}, "timeout_ms": int(duration * 1000)}
            try:
                payload = memoryview(json.dumps(message).encode() + b"\n")
                while payload:
                    count = self.process.stdin.write(payload)
                    if not count:
                        raise OSError("Pipe closed")
                    payload = payload[count:]
                wait_duration = max(duration, 31) if op in ("health", "reconnect") else duration
                if op == "send":
                    wait_duration += 60
                if self._id == 1 or op == "reconnect":
                    wait_duration += 305
                deadline = time.monotonic() + wait_duration + 5
                line = self._read_line(deadline)
                response = json.loads(line)
                if response.get("id") != self._id:
                    self.close()
                    raise CDPError("CDP response mismatch; outcome uncertain. No replay")
            except TimeoutError as error:
                self.close()
                raise CDPError("CDP request timed out; outcome uncertain. Observe before retrying any action") from error
            except EOFError as error:
                self.close()
                raise CDPError("CDP disconnected; check explicit browser/port and run cdp doctor. No replay") from error
            except (OSError, ValueError) as error:
                self.close()
                raise CDPError("CDP transport failed; outcome uncertain. No replay") from error
            self.last_warnings = [item for item in response.get("warnings", []) if isinstance(item, str)]
            for item in self.last_warnings:
                warnings.warn(item, RuntimeWarning, stacklevel=2)
            if "error" in response:
                raise CDPError(response["error"])
            return response["result"]

    def _read_stdout(self):
        """Move blocking pipe reads off the caller thread (Windows pipes aren't selectable)."""
        try:
            while True:
                chunk = self.process.stdout.read(65536)
                if not chunk:
                    break
                self._stdout_queue.put(chunk)
        except OSError:
            # Closing the process or its pipe can interrupt a pending read.
            pass
        finally:
            self._stdout_queue.put(None)

    def _read_line(self, deadline):
        while b"\n" not in self._buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            try:
                chunk = self._stdout_queue.get(timeout=remaining)
            except queue.Empty as error:
                raise TimeoutError from error
            if chunk is None:
                raise EOFError
            self._buffer.extend(chunk)
        line, _, rest = self._buffer.partition(b"\n")
        self._buffer = bytearray(rest)
        return bytes(line).removesuffix(b"\r")

    def activity(self, action="list", **details):
        """Describe progress or pause/resume an owner through the shared daemon."""
        return self.request("activity", params={"action": action, **details})

    def health(self):
        return self.request("health")

    def reconnect(self):
        """Reconnect for future observations; never replay an earlier request."""
        return self.request("reconnect")

    def new_tab(self, url="about:blank"):
        return self.request("new_tab", params={"url": url})["targetId"]

    def attach(self, tab):
        return self.request("attach", params={"tab": tab})["targetId"]

    def send(self, target, method, *, timeout=None, **params):
        return self.request("send", target=target, method=method, params=params, timeout=timeout)

    def release(self, target):
        return self.request("release", target=target)

    def close_tab(self, target):
        return self.request("close_tab", target=target)

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.process.stdin.close()
        if self.process.poll() is None:
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        # A dead child closes its pipe, allowing the reader to finish naturally.
        self._stdout_thread.join(timeout=1)
        self.process.stdout.close()
        if self._stdout_thread.is_alive():
            self._stdout_thread.join(timeout=1)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()
