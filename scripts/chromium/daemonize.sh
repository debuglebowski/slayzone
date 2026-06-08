#!/usr/bin/env bash
# Run a command as a true daemon — survives parent shell / PTY / session death.
#
# macOS has no `setsid` CLI, so we do the classic double-fork + setsid via
# Perl's POSIX::setsid. The grandchild becomes an orphan adopted by launchd
# (pid 1), cannot receive SIGHUP from the parent session, and continues
# running even if this script's parent terminal is killed.
#
# Usage:
#   scripts/chromium/daemonize.sh LOGFILE -- CMD [ARGS...]
# Example:
#   scripts/chromium/daemonize.sh logs/build.log -- bash scripts/chromium/build.sh

set -euo pipefail

if [[ $# -lt 3 || "$2" != "--" ]]; then
  echo "usage: $0 LOGFILE -- CMD [ARGS...]" >&2
  exit 1
fi

LOGFILE="$1"; shift 2

mkdir -p "$(dirname "$LOGFILE")"
: > "$LOGFILE"

# Resolve log path to absolute + capture invoker's cwd before perl takes over.
LOGFILE="$(cd "$(dirname "$LOGFILE")" && pwd)/$(basename "$LOGFILE")"
WORKDIR="$(pwd)"
export WORKDIR

exec perl -e '
  use POSIX;
  # fork 1: detach from shell
  my $pid = fork();
  die "fork1: $!" unless defined $pid;
  exit 0 if $pid;     # parent exits immediately; shell returns
  POSIX::setsid();    # become session leader, detached from controlling tty
  # fork 2: prevent reacquiring a controlling tty
  $pid = fork();
  die "fork2: $!" unless defined $pid;
  exit 0 if $pid;
  # grandchild: close all std streams, reopen to log
  my $log = shift @ARGV;
  open STDIN,  "<", "/dev/null"   or die $!;
  open STDOUT, ">>", $log         or die $!;
  open STDERR, ">>&", \*STDOUT    or die $!;
  chdir $ENV{WORKDIR} or die "chdir $ENV{WORKDIR}: $!";
  umask 0022;
  exec { $ARGV[0] } @ARGV or die "exec: $!";
' "$LOGFILE" "$@"
