{
  description = "pi-voice — push-to-talk voice daemon for the Pi coding agent, packaged for Nix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      bun2nix,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        b2n = bun2nix.packages.${system}.default;
      in
      {
        packages.default = pkgs.callPackage ./default.nix { bun2nix = b2n; inherit pkgs; };

        # `@earendil-works/pi-coding-agent` (+ its exact-pinned `@earendil-works/*` siblings) as
        # a standalone node_modules tree, extracted from this same build (guaranteed to match the
        # version pi-session.ts actually embeds and pi-black expects, by construction, since it's
        # not a separately-maintained lockfile). Consumed by dotfiles to provision
        # `~/.pi/agent/node_modules/@earendil-works` — see pi-session.ts's header comment and
        # default.nix's Electron header comment for why this has to live outside pi-voice's own
        # install tree to be found at all.
        packages.pi-coding-agent-sdk =
          let
            piVoice = self.packages.${system}.default;
            earendilPackages = [
              "pi-coding-agent"
              "pi-agent-core"
              "pi-ai"
              "pi-client"
              "pi-protocol"
              "pi-tui"
              "pi-telemetry"
            ];
          in
          pkgs.runCommandLocal "pi-coding-agent-sdk" { } (
            ''
              mkdir -p $out/@earendil-works
            ''
            # bun's isolated linker suffixes some (not all) of these directories with a
            # peer-dependency-disambiguation hash ("@earendil-works+pi-ai@0.84.1+72022b8d6e175469"),
            # unpredictably -- glob instead of hardcoding the exact directory name.
            + pkgs.lib.concatMapStringsSep "\n" (pkg: ''
              src=(${piVoice}/share/pi-voice/node_modules/.bun/@earendil-works+${pkg}@0.84.1*)
              cp -r "''${src[0]}/node_modules/@earendil-works/${pkg}" "$out/@earendil-works/${pkg}"
            '') earendilPackages
          );
      }
    );
}
