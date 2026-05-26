{ pkgs ? import (fetchTarball
  "https://github.com/NixOS/nixpkgs/archive/fe376f1b538c83167e83ec703c9f4771c3e5292e.tar.gz")
  { } }:

pkgs.mkShell {
  buildInputs = [
    pkgs.git
    pkgs.nodejs
    pkgs.nodePackages_latest.pnpm
  ];
}
