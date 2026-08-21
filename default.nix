# Electron push-to-talk voice daemon for the Pi coding agent. Packaged with bun2nix
# since upstream ships no build/release artifacts, only a Bun-managed source tree.
#
# Notable wrinkles vs. a plain bun2nix.writeBunApplication:
# - `electron` is always spawned by bin/cli.ts (not just for the local STT/TTS
#   path), and its own postinstall (`node install.js`) downloads a prebuilt
#   Electron zip from GitHub at install time — not viable in the Nix sandbox.
#   We skip all lifecycle scripts (`dontRunLifecycleScripts`) and instead point
#   the npm `electron` package at nixpkgs' own electron via
#   `ELECTRON_OVERRIDE_DIST_PATH` at runtime.
# - `uiohook-napi` (global hotkey capture) and `@napi-rs/whisper` (local STT)
#   ship prebuilt native `.node` addons directly in their tarballs, resolved at
#   require-time via `node-gyp-build` — no install-time step is actually
#   needed, just ELF patching so they link against nixpkgs' glibc/X11 instead
#   of whatever generic host they were built on.
{
  lib,
  stdenv,
  pkgs,
  bun2nix,
  # pi-voice pins electron ^40.2.1, but native deps (uiohook-napi, whisper) are
  # N-API based and ABI-stable across Electron versions, so we track nixpkgs'
  # current electron rather than the EOL/insecure electron_40.
  electron,
  libx11,
  libxtst,
  libxi,
  libxinerama,
  libxrandr,
  libxt,
}:
let
  package = builtins.fromJSON (builtins.readFile ./package.json);

  # Only these two packages ship prebuilt native `.node` addons that need
  # relinking against nixpkgs' glibc/X11; a blanket `autoPatchElf` over every
  # fetched dep also walks unrelated platform-optional packages (e.g.
  # esbuild's sunos/win32 builds) that can never be satisfied on NixOS.
  patchNativeAddon =
    extraBuildInputs: pkg:
    pkgs.runCommandLocal "${pkg.name}-patched" {
      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ stdenv.cc.cc.lib ] ++ extraBuildInputs;
    } ''
      mkdir -p $out
      cp -r ${pkg}/. $out
      chmod -R u+w $out
      autoPatchelf $out
    '';

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
    overrides = {
      # Global hotkey capture (X11 XTest) for push-to-talk.
      "uiohook-napi@1.5.4" = patchNativeAddon [
        libx11
        libxtst
        libxi
        libxinerama
        libxrandr
        libxt
      ];
      # Local Whisper STT.
      "@napi-rs/whisper-linux-x64-gnu@0.0.4" = patchNativeAddon [ ];
    };
  };
in
# Not `bun2nix.writeBunApplication`: its default installPhase wraps the start
# script with `--chdir "$out/share/$pname"`, which throws away the caller's
# actual working directory before cli.ts ever reads `process.cwd()` — and
# pi-voice is entirely project-cwd-scoped (`.pi/pi-voice.json`, the pi session
# it spawns, its PID/socket files). We need a plain wrapper that just execs
# `bun <store path>/out/cli/cli.js` from wherever the caller actually is.
bun2nix.mkDerivation {
  pname = "pi-voice";
  version = package.version;

  src = ./.;

  inherit bunDeps;

  # See header comment: electron/uiohook-napi/protobufjs are the only
  # `trustedDependencies` with lifecycle scripts, and none of them need to
  # actually run in the Nix build (electron's postinstall would try to hit
  # the network; the others are no-ops given their prebuilt `.node` files are
  # already in place).
  dontRunLifecycleScripts = true;
  bunInstallFlags = [
    "--linker=isolated"
    "--frozen-lockfile"
  ];

  nativeBuildInputs = [ pkgs.makeWrapper ];

  # Same as `bun run build`, except the CLI bundle also externalizes the two
  # native-addon packages (electron already is, upstream). `config.ts`
  # imports `UiohookKey` purely for its constants, but bundling it flattens
  # away the module's own directory, and its `node-gyp-build(__dirname)`
  # prebuild lookup then resolves against `out/cli/` instead of
  # `node_modules/uiohook-napi/`, and fails to find `prebuilds/`. Same story
  # for whisper (pulled in transitively via services/stt.ts).
  buildPhase = ''
    runHook preBuild
    bun run build:electron
    bun build src/cli.ts --outdir out/cli --target node --format esm \
      --external electron --external uiohook-napi --external '@napi-rs/whisper'
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/pi-voice $out/bin
    cp -r . $out/share/pi-voice

    # Not `${electron}/lib/electron` (doesn't exist) — the npm `electron`
    # package's index.js does `path.join(ELECTRON_OVERRIDE_DIST_PATH,
    # 'electron')`, so this needs to be a directory containing a file
    # literally named `electron`, which is exactly nixpkgs'
    # `electron/bin/electron` wrapper script.
    makeWrapper ${lib.getExe pkgs.bun} $out/bin/pi-voice \
      --add-flags "$out/share/pi-voice/out/cli/cli.js" \
      --set ELECTRON_OVERRIDE_DIST_PATH ${electron}/bin

    runHook postInstall
  '';

  meta = {
    description = "Push-to-talk voice interface for the Pi coding agent";
    homepage = "https://github.com/yukukotani/pi-voice";
    license = lib.licenses.mit;
    mainProgram = "pi-voice";
    platforms = [ "x86_64-linux" ];
  };
}
