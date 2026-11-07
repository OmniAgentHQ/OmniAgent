#!/bin/sh
# OmniAgent Core installer for Linux.
#
#   bash OmniAgent-Linux.sh                Install, or update an existing install
#   bash OmniAgent-Linux.sh --no-engines   Skip the engines, the app can download them later
#   bash OmniAgent-Linux.sh --uninstall    Remove OmniAgent Core
#
# Everything goes in your home folder. The app is packed into the end of this file, and the ChatGPT and
# Claude engines are downloaded from OpenAI and Anthropic, so you always start on their latest versions.
#
# package-core-linux.mjs fills in these values and appends the app.

set -u

APP_VERSION='@@APP_VERSION@@'
PAYLOAD_BYTES='@@PAYLOAD_BYTES@@'
PAYLOAD_SHA256='@@PAYLOAD_SHA256@@'
APP_KB='@@APP_KB@@'

APP_ID=omniagent-core
APP_NAME='OmniAgent Core'
MIN_GLIBC_MINOR=28
ENGINES_KB=1500000

DATA_HOME=${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_HOME=${XDG_CONFIG_HOME:-$HOME/.config}
INSTALL_DIR=$DATA_HOME/$APP_ID
APP_DIR=$INSTALL_DIR/app
NEW_APP_DIR=$INSTALL_DIR/.app-new
APP_BINARY=$APP_DIR/$APP_ID
LAUNCHER=$INSTALL_DIR/$APP_ID
UNINSTALLER=$INSTALL_DIR/uninstall.sh
MENU_ENTRY=$DATA_HOME/applications/$APP_ID.desktop
ICON_FILE=$DATA_HOME/icons/hicolor/256x256/apps/$APP_ID.png
BIN_LINK=$HOME/.local/bin/$APP_ID
USER_DATA=$CONFIG_HOME/$APP_NAME
ENGINES_DIR=$USER_DATA/providers
APPARMOR_PROFILE=/etc/apparmor.d/$APP_ID-$(id -un)

STAGING_DIR=
BACKGROUND_PID=
ENGINE_FAILED=
SANDBOX_OFF=

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m') RED=$(printf '\033[31m') RESET=$(printf '\033[0m')
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' RESET=''
fi

case ${LC_ALL:-${LC_CTYPE:-${LANG:-}}} in
  *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*) TICK='✓' CROSS='✗' BLOCK='█' TRACK='░' ;;
  *) TICK='+' CROSS='x' BLOCK='#' TRACK='-' ;;
esac

say() { printf '%s\n' "$*"; }
done_step() { printf '  %s%s%s %s\n' "$GREEN" "$TICK" "$RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die() {
  printf '\n  %s%s%s %s\n\n' "$RED" "$CROSS" "$RESET" "$*" >&2
  exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
shown_path() {
  case $1 in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}
shell_quoted() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Prompts read the terminal directly so they still work if stdin isn't one.
can_ask() { [ -r /dev/tty ] && [ -w /dev/tty ] && (: </dev/tty) 2>/dev/null; }
ask_yes() {
  can_ask || return 1
  printf '  %s [Y/n] ' "$1"
  read -r answer </dev/tty || return 1
  case $answer in
    '' | [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

cleanup() {
  if [ -n "$BACKGROUND_PID" ]; then kill "$BACKGROUND_PID" 2>/dev/null; fi
  if [ -n "$STAGING_DIR" ]; then rm -rf "$STAGING_DIR"; fi
  rm -rf "$NEW_APP_DIR"
}

interrupted() {
  printf '\n'
  warn 'Stopped. Run the installer again to finish.'
  exit 130
}

trap cleanup EXIT
trap interrupted INT TERM HUP

# Progress line

now_ms() {
  now=$(date +%s%3N)
  case $now in
    *N*) printf '%s000' "$(date +%s)" ;;
    *) printf '%s' "$now" ;;
  esac
}

terminal_width() {
  width=$( (stty size </dev/tty) 2>/dev/null | cut -d' ' -f2)
  case $width in
    '' | 0 | *[!0-9]*) printf 80 ;;
    *) printf '%s' "$width" ;;
  esac
}

as_mb() {
  tenths=$(($1 / 100000))
  printf '%d.%d' $((tenths / 10)) $((tenths % 10))
}

as_time() {
  if [ "$1" -ge 60 ]; then printf '%dm %02ds' $(($1 / 60)) $(($1 % 60)); else printf '%ds' "$1"; fi
}

bar_of() {
  position=0
  bar=''
  while [ "$position" -lt "$2" ]; do
    if [ "$position" -lt "$1" ]; then bar=$bar$BLOCK; else bar=$bar$TRACK; fi
    position=$((position + 1))
  done
  printf '%s' "$bar"
}

size_of_file() { if [ -f "$1" ]; then wc -c <"$1"; else printf 0; fi; }
size_of_folder() { printf '%s' $(($(du -sk "$1" 2>/dev/null | cut -f1) * 1024)); }

# Redraws the line until the background job finishes, then returns the job's exit code.
#   $1 job id, $2 function that measures progress, $3 what it measures, $4 total bytes (0 if unknown),
#   $5 "speed" to show the download rate
follow_job() {
  job=$1 measure=$2 subject=$3 total=$4 detail=$5
  bar_width=$(($(terminal_width) - 52))
  if [ "$bar_width" -gt 36 ]; then bar_width=36; fi
  last_time=$(now_ms) last_bytes=0 speed=0 next_mark=25

  while kill -0 "$job" 2>/dev/null; do
    bytes=$("$measure" "$subject")
    bytes=$((bytes + 0))
    if [ "$detail" = speed ]; then
      time_now=$(now_ms)
      elapsed=$((time_now - last_time))
      # Downloads arrive in bursts, so the first reading is quick and the rest cover a few seconds.
      if { [ "$speed" -eq 0 ] && [ "$elapsed" -ge 500 ]; } || [ "$elapsed" -ge 2000 ]; then
        rate=$(((bytes - last_bytes) * 1000 / elapsed))
        if [ "$rate" -lt 0 ]; then rate=0; fi
        if [ "$speed" -eq 0 ]; then speed=$rate; else speed=$(((speed + rate) / 2)); fi
        last_time=$time_now last_bytes=$bytes
      fi
    fi

    percent=0
    if [ "$total" -gt 0 ]; then percent=$((bytes * 100 / total)); fi
    if [ "$percent" -gt 100 ]; then percent=100; fi

    text=''
    if [ "$total" -gt 0 ]; then text=" $(printf '%3d' "$percent")%"; fi
    if [ "$detail" = speed ]; then
      text="$text  $(as_mb "$bytes")"
      if [ "$total" -gt 0 ]; then text="$text / $(as_mb "$total")"; fi
      text="$text MB  $(as_mb "$speed") MB/s"
      if [ "$total" -gt 0 ] && [ "$speed" -gt 0 ]; then
        text="$text  $(as_time $(((total - bytes) / speed))) left"
      fi
    fi

    if [ -t 1 ]; then
      if [ "$total" -gt 0 ] && [ "$bar_width" -ge 10 ]; then
        printf '\r\033[K  %s%s' "$(bar_of $((percent * bar_width / 100)) "$bar_width")" "$text"
      else
        printf '\r\033[K %s' "$text"
      fi
    elif [ "$percent" -ge "$next_mark" ]; then
      say " $text"
      next_mark=$((next_mark + 25))
    fi
    sleep 0.25 2>/dev/null || sleep 1
  done

  if [ -t 1 ]; then printf '\r\033[K'; fi
  wait "$job"
}

# Network

fetch_text() {
  if have curl; then
    curl -fsSL --connect-timeout 20 --max-time 60 --retry 3 "$1"
  else
    wget -q -T 30 -O - "$1"
  fi
}

remote_size() {
  if have curl; then
    curl -fsIL --connect-timeout 20 --max-time 30 "$1" 2>/dev/null
  else
    wget -q -S --spider -T 20 "$1" 2>&1
  fi | tr -d '\r' | awk 'tolower($1) == "content-length:" { size = $2 } END { print size + 0 }'
}

# Downloads $1 to $2 with a progress line. The label is printed first so it stays above the bar.
download() {
  say "  ${BOLD}Downloading $3${RESET}"
  total=$(remote_size "$1")
  if have curl; then
    curl -fsSL --connect-timeout 20 --retry 4 --retry-delay 2 --speed-time 60 --speed-limit 1024 -o "$2" "$1" &
  else
    wget -q --tries=5 --timeout=30 -O "$2" "$1" &
  fi
  BACKGROUND_PID=$!
  follow_job "$BACKGROUND_PID" size_of_file "$2" "${total:-0}" speed
  result=$?
  BACKGROUND_PID=
  return "$result"
}

matches_checksum() { [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ]; }

# System checks

distro_name() {
  name=$(sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null)
  printf '%s' "${name:-Linux}"
}

check_system() {
  if [ "$(id -u)" -eq 0 ]; then
    die "Run this as your normal user, without sudo. It installs into your home folder and asks for your password only if it needs it."
  fi
  case $(uname -m) in
    x86_64 | amd64) ;;
    *) die "This installer is for 64-bit Intel and AMD computers, and this one is $(uname -m)." ;;
  esac

  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | cut -d' ' -f2)
  if [ -z "$glibc" ]; then
    die "$APP_NAME needs a glibc based distro such as Ubuntu, Debian, Fedora or Arch."
  fi
  glibc_major=${glibc%%.*}
  glibc_minor=${glibc#*.}
  glibc_minor=${glibc_minor%%.*}
  if [ "$glibc_major" -lt 2 ] || { [ "$glibc_major" -eq 2 ] && [ "$glibc_minor" -lt "$MIN_GLIBC_MINOR" ]; }; then
    die "$APP_NAME needs glibc 2.$MIN_GLIBC_MINOR or newer, and this system has $glibc."
  fi

  for tool in tar gzip sha256sum; do
    have "$tool" || die "This installer needs '$tool', which isn't installed."
  done
  if [ "$SKIP_ENGINES" = no ] && ! have curl && ! have wget; then
    die "Downloading the engines needs curl or wget. Install one and run this again."
  fi

  needed_kb=$APP_KB
  if [ "$SKIP_ENGINES" = no ]; then needed_kb=$((needed_kb + ENGINES_KB)); fi
  free_kb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')
  if [ -n "$free_kb" ] && [ "$free_kb" -lt "$needed_kb" ]; then
    die "$APP_NAME needs about $((needed_kb / 1000)) MB free, and your home folder has $((free_kb / 1000)) MB."
  fi
  done_step "$(distro_name), 64-bit"
}

check_download() {
  [ -f "$0" ] || die "Download the installer first, then run it from the file."
  if [ "$(wc -c <"$0")" -le "$PAYLOAD_BYTES" ]; then
    die "This installer is incomplete. Download it again."
  fi
  actual=$(tail -c "$PAYLOAD_BYTES" "$0" | sha256sum | cut -d' ' -f1)
  [ "$actual" = "$PAYLOAD_SHA256" ] || die "This installer is damaged. Download it again."
  done_step 'Installer verified'
}

app_is_running() { have pgrep && pgrep -f -- "$APP_BINARY" >/dev/null 2>&1; }

# Install

install_app() {
  if app_is_running; then die "$APP_NAME is open. Close it and run this again."; fi
  mkdir -p "$INSTALL_DIR"
  rm -rf "$NEW_APP_DIR"
  mkdir -p "$NEW_APP_DIR"

  say "  ${BOLD}Installing $APP_NAME $APP_VERSION${RESET}"
  tail -c "$PAYLOAD_BYTES" "$0" | tar -xzf - -C "$NEW_APP_DIR" --strip-components=1 &
  BACKGROUND_PID=$!
  follow_job "$BACKGROUND_PID" size_of_folder "$NEW_APP_DIR" $((APP_KB * 1024)) percent
  result=$?
  BACKGROUND_PID=
  [ "$result" -eq 0 ] || die "$APP_NAME could not be unpacked. Check that your disk has space, then run this again."

  rm -rf "$APP_DIR"
  mv "$NEW_APP_DIR" "$APP_DIR"
  done_step "$APP_NAME $APP_VERSION installed"
}

# Ubuntu blocks the app's sandbox unless the app has an AppArmor rule, so anything that changes that
# after installing, like a distro upgrade, is picked up here on every launch.
write_launcher() {
  {
    printf '#!/bin/sh\n'
    printf 'APP_BINARY=%s\n' "$(shell_quoted "$APP_BINARY")"
    printf 'APPARMOR_PROFILE=%s\n' "$(shell_quoted "$APPARMOR_PROFILE")"
    cat <<'LAUNCHER'

sandbox_is_blocked() {
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ ! -e "$APPARMOR_PROFILE" ]; then
    return 0
  fi
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ] && return 0
  [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null)" = 0 ] && return 0
  return 1
}

if sandbox_is_blocked; then exec "$APP_BINARY" --no-sandbox "$@"; fi
exec "$APP_BINARY" "$@"
LAUNCHER
  } >"$LAUNCHER"
  chmod 755 "$LAUNCHER"
}

# The Exec line quotes the launcher, and GNOME finds the running window through the file's name on
# Wayland and through StartupWMClass on X11.
add_to_menu() {
  mkdir -p "$(dirname "$MENU_ENTRY")" "$(dirname "$ICON_FILE")" "$(dirname "$BIN_LINK")"
  cp "$APP_DIR/resources/icon.png" "$ICON_FILE"
  escaped=$(printf '%s' "$LAUNCHER" | sed 's/[\\"`$]/\\&/g; s/%/%%/g')
  cat >"$MENU_ENTRY" <<ENTRY
[Desktop Entry]
Type=Application
Name=$APP_NAME
GenericName=AI Agents
Comment=ChatGPT and Claude on the same team
Exec="$escaped"
Icon=$APP_ID
Terminal=false
Categories=Utility;
StartupWMClass=$APP_NAME
StartupNotify=true
ENTRY
  chmod 644 "$MENU_ENTRY"
  ln -sf "$LAUNCHER" "$BIN_LINK"
  if have update-desktop-database; then update-desktop-database "$(dirname "$MENU_ENTRY")" 2>/dev/null; fi
  touch "$DATA_HOME/icons/hicolor" 2>/dev/null
  done_step 'Added to your applications menu'
}

apt_packages() {
  for package in libnss3 libgbm1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2; do
    printf '%s ' "$package"
  done
  # Newer Debian and Ubuntu renamed these with a t64 ending.
  for package in libasound2 libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 libcups2 libgtk-3-0; do
    if apt-cache show "${package}t64" >/dev/null 2>&1; then printf '%st64 ' "$package"; else printf '%s ' "$package"; fi
  done
}

missing_libraries() { ldd "$APP_BINARY" 2>/dev/null | awk '/not found/ { print $1 }' | sort -u | tr '\n' ' '; }

check_libraries() {
  missing=$(missing_libraries)
  [ -z "$missing" ] && return 0

  warn "Your system is missing libraries the app needs: $missing"
  if have apt-get; then
    command="sudo apt-get install -y $(apt_packages)"
  elif have dnf; then
    command='sudo dnf install -y nss atk at-spi2-atk at-spi2-core cups-libs gtk3 mesa-libgbm alsa-lib libxkbcommon libXcomposite libXdamage libXrandr'
  elif have pacman; then
    command='sudo pacman -S --needed --noconfirm nss atk at-spi2-core libcups gtk3 mesa alsa-lib libxkbcommon libxcomposite libxdamage libxrandr'
  elif have zypper; then
    command='sudo zypper install -y mozilla-nss libatk-1_0-0 libatk-bridge-2_0-0 libatspi0 libcups2 libgtk-3-0 libgbm1 libasound2 libxkbcommon0 libXcomposite1 libXdamage1 libXrandr2'
  else
    warn 'Install them with your package manager, then open the app.'
    return 0
  fi

  if ask_yes 'Install them now? This needs your password.'; then
    # The command is built above from fixed package names, so splitting it on spaces is intended.
    # shellcheck disable=SC2086
    $command
  fi
  missing=$(missing_libraries)
  if [ -z "$missing" ]; then
    done_step 'Libraries installed'
  else
    warn "The app won't open until these are installed: $missing"
    warn "This should do it: $command"
  fi
}

# Without this rule the launcher starts the app with --no-sandbox, so the app still works.
allow_sandbox() {
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] || return 0
  if [ -r "$APPARMOR_PROFILE" ] && grep -qF "\"$APP_BINARY\"" "$APPARMOR_PROFILE"; then return 0; fi

  if ! have sudo || ! have apparmor_parser; then
    SANDBOX_OFF=yes
    return 0
  fi
  say ''
  say "  $(distro_name) needs a small AppArmor rule so the app's security sandbox can run."
  say '  Your password is used for this one step, and only on this computer.'

  rule=$(mktemp)
  cat >"$rule" <<RULE
abi <abi/4.0>,
include <tunables/global>

profile $APP_ID-$(id -un) "$APP_BINARY" flags=(unconfined) {
  userns,

  include if exists <local/$APP_ID>
}
RULE
  # The two paths are handed over as arguments, so nothing in them is read as a command.
  if sudo sh -c 'install -m 644 "$1" "$2" && { apparmor_parser --replace --write-cache --skip-read-cache "$2" || { rm -f "$2"; exit 1; }; }' sh "$rule" "$APPARMOR_PROFILE"; then
    done_step 'Sandbox rule added'
  else
    SANDBOX_OFF=yes
  fi
  rm -f "$rule"
  say ''
}

write_uninstaller() {
  {
    printf '#!/bin/sh\n# Removes OmniAgent Core. Written by its installer.\n\nset -u\n\n'
    for name in APP_NAME APP_BINARY INSTALL_DIR MENU_ENTRY ICON_FILE BIN_LINK USER_DATA ENGINES_DIR APPARMOR_PROFILE; do
      eval "value=\$$name"
      printf '%s=%s\n' "$name" "$(shell_quoted "$value")"
    done
    cat <<'UNINSTALL'

if command -v pgrep >/dev/null 2>&1 && pgrep -f -- "$APP_BINARY" >/dev/null 2>&1; then
  printf '\n  %s is open. Close it and run this again.\n\n' "$APP_NAME"
  exit 1
fi

printf '\n  Removing %s\n' "$APP_NAME"
rm -f "$MENU_ENTRY" "$ICON_FILE"
if [ -L "$BIN_LINK" ]; then rm -f "$BIN_LINK"; fi
rm -rf "$ENGINES_DIR"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$MENU_ENTRY")" 2>/dev/null

if [ -e "$APPARMOR_PROFILE" ]; then
  printf '  Removing its AppArmor rule needs your password.\n'
  # The path is handed over as an argument, so nothing in it is read as a command.
  if ! sudo sh -c 'apparmor_parser --remove "$1" 2>/dev/null; rm -f "$1"' sh "$APPARMOR_PROFILE"; then
    printf '  That was skipped. To remove it later: sudo rm %s\n' "$APPARMOR_PROFILE"
  fi
fi

if [ -d "$USER_DATA" ] && [ -r /dev/tty ] && (: </dev/tty) 2>/dev/null; then
  printf '  Also delete your settings, chat history and saved logins? This cannot be undone. [y/N] '
  read -r answer </dev/tty || answer=''
  case $answer in
    [Yy]*) rm -rf "$USER_DATA" ;;
    *) printf '  Kept them in %s\n' "$USER_DATA" ;;
  esac
fi

rm -rf "$INSTALL_DIR"
printf '  %s is uninstalled.\n\n' "$APP_NAME"
UNINSTALL
  } >"$UNINSTALLER"
  chmod 755 "$UNINSTALLER"
}

# Engines. These live where the app looks for them, so its welcome screen shows them as ready.

# The app's own updater keeps newer engines under updates/ and points at them from a small file.
engine_in_use() {
  pointer=$ENGINES_DIR/$1-active.json
  if [ -f "$pointer" ]; then
    relative=$(sed -n 's/.*"path" *: *"\([^"]*\)".*/\1/p' "$pointer")
    if [ -n "$relative" ] && [ -x "$ENGINES_DIR/$relative" ]; then
      printf '%s' "$ENGINES_DIR/$relative"
      return 0
    fi
  fi
  if [ -x "$2" ]; then printf '%s' "$2"; fi
}

engine_is_current() {
  [ -n "$1" ] || return 1
  [ -n "$2" ] || return 1
  [ "$("$1" --version 2>/dev/null | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1)" = "$2" ]
}

activate_engine() {
  rm -rf "${ENGINES_DIR:?}/$1" "${ENGINES_DIR:?}/updates/$1" "${ENGINES_DIR:?}/$1-active.json"
  mv "$2" "$ENGINES_DIR/$1"
}

engine_failed() {
  warn "$1 engine: $2"
  ENGINE_FAILED="${ENGINE_FAILED}${ENGINE_FAILED:+ and }$1"
}

install_chatgpt_engine() {
  asset=codex-package-x86_64-unknown-linux-musl.tar.gz
  release=$(fetch_text https://api.github.com/repos/openai/codex/releases/latest 2>/dev/null | tr ',' '\n')
  version=$(printf '%s\n' "$release" | sed -n 's/.*"tag_name" *: *"[^0-9]*\([0-9][^"]*\)".*/\1/p' | head -n 1)
  checksum=$(printf '%s\n' "$release" | awk -F'"' -v wanted="$asset" '
    $2 == "name" { current = $4 }
    $2 == "digest" && current == wanted { sub(/^sha256:/, "", $4); print $4; exit }')

  if engine_is_current "$(engine_in_use codex "$ENGINES_DIR/codex/bin/codex")" "$version"; then
    done_step "ChatGPT engine $version is already the latest"
    return 0
  fi

  archive=$STAGING_DIR/$asset
  if ! download "https://github.com/openai/codex/releases/latest/download/$asset" "$archive" "ChatGPT engine${version:+ $version}"; then
    engine_failed ChatGPT 'the download failed.'
    return 0
  fi
  if [ -n "$checksum" ] && ! matches_checksum "$archive" "$checksum"; then
    engine_failed ChatGPT 'the download failed its checksum check.'
    return 0
  fi

  unpacked=$STAGING_DIR/codex
  mkdir -p "$unpacked"
  if ! tar -xzf "$archive" -C "$unpacked" || [ ! -x "$unpacked/bin/codex" ]; then
    engine_failed ChatGPT 'the download could not be unpacked.'
    return 0
  fi
  rm -f "$archive"
  activate_engine codex "$unpacked"
  done_step "ChatGPT engine${version:+ $version} ready"
}

install_claude_engine() {
  releases=https://downloads.claude.ai/claude-code-releases
  version=$(fetch_text "$releases/latest" 2>/dev/null | tr -d '[:space:]')
  case $version in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *)
      engine_failed Claude "couldn't find the latest version."
      return 0
      ;;
  esac
  checksum=$(fetch_text "$releases/$version/manifest.json" 2>/dev/null | tr -d '[:space:]' |
    sed -n 's/.*"linux-x64":{[^}]*"checksum":"\([0-9a-f]\{64\}\)".*/\1/p')
  if [ -z "$checksum" ]; then
    engine_failed Claude "couldn't verify the latest version."
    return 0
  fi

  if engine_is_current "$(engine_in_use claude "$ENGINES_DIR/claude/claude")" "$version"; then
    done_step "Claude engine $version is already the latest"
    return 0
  fi

  unpacked=$STAGING_DIR/claude
  mkdir -p "$unpacked"
  if ! download "$releases/$version/linux-x64/claude" "$unpacked/claude" "Claude engine $version"; then
    engine_failed Claude 'the download failed.'
    return 0
  fi
  if ! matches_checksum "$unpacked/claude" "$checksum"; then
    engine_failed Claude 'the download failed its checksum check.'
    return 0
  fi
  chmod 755 "$unpacked/claude"
  activate_engine claude "$unpacked"
  done_step "Claude engine $version ready"
}

install_engines() {
  mkdir -p "$ENGINES_DIR"
  STAGING_DIR=$ENGINES_DIR/.staging-installer-$$
  mkdir -p "$STAGING_DIR"
  install_chatgpt_engine
  install_claude_engine
  rm -rf "$STAGING_DIR"
  STAGING_DIR=
}

finish() {
  say ''
  say "  ${GREEN}${BOLD}$APP_NAME is ready.${RESET}"
  say ''
  case ":$PATH:" in
    *":$(dirname "$BIN_LINK"):"*) command_name=$APP_ID ;;
    *) command_name=$(shown_path "$BIN_LINK") ;;
  esac
  say "  Open it from your applications menu, or run: ${BOLD}$command_name${RESET}"
  say "  ${DIM}To uninstall: bash $(shown_path "$UNINSTALLER")${RESET}"
  if [ -n "$ENGINE_FAILED" ]; then
    say ''
    warn "The $ENGINE_FAILED engine didn't install. The app's welcome screen can download it for you."
  fi
  if [ -n "$SANDBOX_OFF" ]; then
    say ''
    warn "The app's security sandbox is off, because this system blocks it without an admin step."
    warn 'Run this installer again with an admin account to turn it on.'
  fi
  say ''
}

uninstall() {
  if [ -x "$UNINSTALLER" ]; then exec sh "$UNINSTALLER"; fi
  say "$APP_NAME isn't installed."
  exit 0
}

usage() {
  say 'OmniAgent Core installer for Linux'
  say ''
  say '  bash OmniAgent-Linux.sh                Install, or update an existing install'
  say '  bash OmniAgent-Linux.sh --no-engines   Skip the engines, the app can download them later'
  say '  bash OmniAgent-Linux.sh --uninstall    Remove OmniAgent Core'
}

SKIP_ENGINES=no
for argument in "$@"; do
  case $argument in
    --uninstall) uninstall ;;
    --no-engines) SKIP_ENGINES=yes ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 1
      ;;
  esac
done

say ''
say "  ${BOLD}$APP_NAME $APP_VERSION for Linux${RESET}"
say ''
check_system
check_download
install_app
write_launcher
add_to_menu
write_uninstaller
check_libraries
allow_sandbox
if [ "$SKIP_ENGINES" = no ]; then install_engines; fi
finish
exit 0
# The packed app starts after this line.
