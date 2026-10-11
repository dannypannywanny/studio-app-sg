#!/bin/sh
# The Firebase emulators (firebase-tools 14+) need Java 21 or newer.
# If the default `java` is older, use Homebrew's keg-only openjdk@21 for this command only.
major=$(java -version 2>&1 | awk -F'"' '/version/ {print $2}' | cut -d. -f1)
if [ -z "$major" ] || [ "$major" -lt 21 ]; then
  for prefix in /opt/homebrew/opt/openjdk@21 /usr/local/opt/openjdk@21; do
    if [ -x "$prefix/bin/java" ]; then
      JAVA_HOME="$prefix/libexec/openjdk.jdk/Contents/Home"
      PATH="$prefix/bin:$PATH"
      export JAVA_HOME PATH
      break
    fi
  done
fi
exec "$@"
