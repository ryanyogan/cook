#!/usr/bin/env bash
# Runs a long-lived program for an Erlang Port and makes sure it dies with the Port.
#
# Ports only close the program's stdin when their owner dies, and neither Node nor
# a BEAM started with `--no-halt` exits on stdin EOF. This wrapper starts the
# program in its own process group, watches stdin, and kills the whole group when
# stdin closes (so Chromium children of the Playwright server go too).
#
# Usage: port_wrapper.sh SIGNAL PROGRAM [ARGS...]
#
# SIGNAL (TERM or KILL) is sent first; KILL always follows within a second.

signal=$1
shift

setsid "$@" &
pid=$!

{
  while read -r _; do :; done
  kill "-$signal" -- "-$pid" 2>/dev/null
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$pid" 2>/dev/null || exit 0
    sleep 0.1
  done
  kill -KILL -- "-$pid" 2>/dev/null
} <&0 >/dev/null 2>&1 &
watcher=$!

wait "$pid"
status=$?

kill -KILL "$watcher" 2>/dev/null
kill -KILL -- "-$pid" 2>/dev/null
exit "$status"
