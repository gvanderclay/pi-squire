"""Opt-in private tmux test only: provide an actual controlling PTY, no inference."""
import fcntl
import os
import pty
import signal
import struct
import sys
import termios

pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
    os.execv(sys.argv[1], sys.argv[1:])

def stop(_signal, _frame):
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
try:
    while True:
        data = os.read(fd, 8192)
        if not data:
            break
        os.write(1, data)
except OSError:
    pass
finally:
    os.close(fd)
    os.waitpid(pid, 0)
