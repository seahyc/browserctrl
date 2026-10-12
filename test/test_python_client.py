import importlib.util
import io
import json
import os
import queue
from pathlib import Path
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('client', ROOT / 'python/chrome_cdp/__init__.py')
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class FakeProcess:
    def __init__(self, replies):
        reader, writer = os.pipe()
        os.write(writer, b''.join(json.dumps(row).encode() + b'\n' for row in replies))
        self.writer = writer
        self.stdout = os.fdopen(reader, 'rb', buffering=0)
        self.stdin = _RecordingInput(self)
        self.pid = 123

    def poll(self):
        return 0

    def finish(self):
        self.stdin.close()
        try:
            self.stdout.close()
        except OSError:
            pass


class _RecordingInput(io.BytesIO):
    def __init__(self, process):
        super().__init__()
        self.process = process
        self._saved = None

    def getvalue(self):
        return super().getvalue() if self._saved is None else self._saved

    def close(self):
        if not self.closed:
            self._saved = super().getvalue()
            try:
                os.close(self.process.writer)
            except OSError:
                pass
        super().close()


class ClientTests(unittest.TestCase):
    def test_explicit_selector_required(self):
        for kwargs in [{}, {'browser': 'dia', 'port': 9223}]:
            with self.assertRaises(ValueError):
                client.ChromeCDP(**kwargs)

    def test_reuses_process_and_consumes_buffered_responses(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}, {'id': 2, 'result': {'targetId': 'test'}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake) as spawn:
                sdk = client.ChromeCDP(browser='dia')
                self.assertEqual(sdk.new_tab(), 'test')
                self.assertEqual(spawn.call_count, 1)
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual([row['op'] for row in rows], ['health', 'new_tab'])
                sdk.close()
        finally:
            fake.finish()

    def test_activity_uses_sidecar_and_reports_navigation_warnings(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}},
                            {'id': 2, 'result': {'agents': []},
                             'warnings': ['Agent reviewer: 5 navigation actions']}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                sdk = client.ChromeCDP(browser='dia')
                with self.assertWarnsRegex(RuntimeWarning, 'reviewer'):
                    self.assertEqual(sdk.activity('describe', intent='Review links', completed=1, total=91), {'agents': []})
                self.assertEqual(sdk.last_warnings, ['Agent reviewer: 5 navigation actions'])
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual(rows[-1]['op'], 'activity')
                self.assertEqual(rows[-1]['params']['intent'], 'Review links')
                sdk.close()
        finally:
            fake.finish()

    def test_timeout_does_not_replay(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                sdk = client.ChromeCDP(browser='dia')
                with patch.object(sdk._stdout_queue, 'get', side_effect=queue.Empty):
                    with self.assertRaisesRegex(client.CDPError, 'outcome uncertain'):
                        sdk.send('test', 'Input.insertText', text='hello')
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual(sum(row['method'] == 'Input.insertText' for row in rows), 1)
                self.assertTrue(sdk._closed)
                self.assertFalse(sdk._stdout_thread.is_alive())
        finally:
            fake.finish()

    def test_initialization_allowance_keeps_the_requested_action_timeout(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                original_get = queue.Queue.get
                waits = []

                def recording_get(instance, *args, **kwargs):
                    waits.append(kwargs.get('timeout'))
                    return original_get(instance, *args, **kwargs)

                with patch.object(queue.Queue, 'get', recording_get):
                    sdk = client.ChromeCDP(browser='dia')
                self.assertGreater(waits[-1], 330)
                # The first reply was consumed during initialization. Supply the
                # next reply through the actual pipe and observe the send allowance.
                os.write(fake.writer, json.dumps({'id': 2, 'result': {}}).encode() + b'\n')
                waits.clear()
                with patch.object(queue.Queue, 'get', recording_get):
                    sdk.send('test', 'Runtime.evaluate', timeout=0.1, expression='1')
                self.assertGreater(waits[-1], 60)
                self.assertLess(waits[-1], 66)
                rows = [json.loads(row) for row in fake.stdin.getvalue().splitlines()]
                self.assertEqual(rows[-1]['timeout_ms'], 100)
                self.assertEqual(len(rows), 2)
                sdk.close()
        finally:
            fake.finish()

    def test_actual_subprocess_pipe_echo_and_bounded_deadline(self):
        script = (
            "import sys,time\n"
            "for line in sys.stdin:\n"
            "    time.sleep(0.12)\n"
            "    sys.stdout.write(line)\n"
            "    sys.stdout.flush()\n"
        )
        process = subprocess.Popen(
            [sys.executable, '-u', '-c', script], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0,
        )
        sdk = client.ChromeCDP.__new__(client.ChromeCDP)
        sdk.process = process
        sdk._buffer = bytearray()
        sdk._stdout_queue = queue.Queue()
        sdk._stdout_thread = client.threading.Thread(
            target=sdk._read_stdout, name='test-browserctrl-stdout', daemon=True,
        )
        sdk._stdout_thread.start()
        try:
            process.stdin.write(b'{"id":1}\n')
            process.stdin.flush()
            deadline = time.monotonic() + 2
            self.assertEqual(sdk._read_line(deadline), b'{"id":1}')

            process.stdin.write(b'{"id":2}\n')
            process.stdin.flush()
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                sdk._read_line(started + 0.02)
            self.assertLess(time.monotonic() - started, 0.1)
        finally:
            process.stdin.close()
            process.terminate()
            process.wait(timeout=3)
            sdk._stdout_thread.join(timeout=2)
            if sdk._stdout_thread.is_alive():
                process.stdout.close()
                sdk._stdout_thread.join(timeout=1)
            else:
                process.stdout.close()
            self.assertFalse(sdk._stdout_thread.is_alive())

    def test_error_is_not_retried(self):
        fake = FakeProcess([{'id': 1, 'result': {'ok': True}}, {'id': 2, 'error': 'claimed by another owner'}])
        try:
            with patch.object(client.subprocess, 'Popen', return_value=fake):
                sdk = client.ChromeCDP(browser='dia')
                with self.assertRaisesRegex(client.CDPError, 'claimed'):
                    sdk.attach('test')
                self.assertEqual(len(fake.stdin.getvalue().splitlines()), 2)
                sdk.close()
        finally:
            fake.finish()


if __name__ == '__main__':
    unittest.main()
