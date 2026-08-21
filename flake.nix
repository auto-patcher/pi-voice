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
      }
    );
}
