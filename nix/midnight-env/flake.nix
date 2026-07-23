{
  description = "Reproducible PREPROD dev environment for the Midnight Network + Cardano dependency chain (midnight-node 1.0.1 = Ledger 8; db-sync served over TLS) (node, indexer, proof-server, wallet-sdk, cardano-node, cardano-db-sync, PostgreSQL), with backup/restore for synced chain state.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # Midnight components: compose their own upstream flakes, pinned to the exact
    # commits this environment was built and verified against. Update these pins
    # deliberately (not `nix flake update`) so the environment stays reproducible.
    # midnight-node itself is NOT consumed as a flake input (see midnight-node-bin
    # below, a pinned release binary) -- kept here as source only for reference/
    # future from-source builds.
    midnight-node-src = {
      url = "github:midnightntwrk/midnight-node/f92fc29684fc088f4591f04777a58c526f3b3828"; # tag node-1.0.1 -- the exact commit whose release binary this flake pins
      flake = false;
    };
    midnight-ledger = {
      url = "github:midnightntwrk/midnight-ledger/e1edad2d7019e1520d173f3e22e9991903225cef";
    };
    midnight-wallet = {
      url = "github:midnightntwrk/midnight-wallet/27c5352d760c2450f04cc08651a49aaba3e4081a";
    };
    midnight-dapp-connector-api = {
      url = "github:midnightntwrk/midnight-dapp-connector-api/da90f631d45338d640365fb3d868e095130b4d6d";
    };
  };

  outputs = { self, nixpkgs, flake-utils, midnight-node-src, midnight-ledger, midnight-wallet, midnight-dapp-connector-api }:
    flake-utils.lib.eachSystem [ "x86_64-linux" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # --- Cardano: pinned pre-built release binaries (NOT built from source via
        # haskell.nix). This is a deliberate choice: haskell.nix flake evaluation is
        # slow and a from-source build risks multi-hour compilation if the exact
        # point-release revs are not cache-hot on cache.iog.io. These binaries are
        # exactly what this environment has been running and verified against.
        cardano-node-bin = pkgs.stdenv.mkDerivation {
          pname = "cardano-node-bin";
          version = "11.0.1";
          src = pkgs.fetchurl {
            url = "https://github.com/IntersectMBO/cardano-node/releases/download/11.0.1/cardano-node-11.0.1-linux-amd64.tar.gz";
            sha256 = "40e88a543564251338c4888ef79fde51d2306c18b48ac308c9eab3220e3a13f0";
          };
          sourceRoot = ".";
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.glibc pkgs.gmp pkgs.ncurses pkgs.zlib pkgs.systemd ];
          installPhase = ''
            mkdir -p $out/bin
            cp bin/cardano-node bin/cardano-cli $out/bin/
            chmod +x $out/bin/*
          '';
        };

        cardano-db-sync-bin = pkgs.stdenv.mkDerivation {
          pname = "cardano-db-sync-bin";
          version = "13.7.1.0";
          src = pkgs.fetchurl {
            url = "https://github.com/IntersectMBO/cardano-db-sync/releases/download/13.7.1.0/cardano-db-sync-13.7.1.0-linux.tar.gz";
            sha256 = "2e35bdfe91490acafa030afa07bb9a504a6ed48d8fa5eeb0ecee65b034975b75";
          };
          sourceRoot = ".";
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.glibc pkgs.gmp pkgs.ncurses pkgs.zlib pkgs.postgresql.lib ];
          installPhase = ''
            mkdir -p $out/bin $out/share/cardano-db-sync
            find . -maxdepth 2 -iname "cardano-db-sync*" -type f -exec cp {} $out/bin/cardano-db-sync \; -quit
            chmod +x $out/bin/cardano-db-sync
            if [ -d schema ]; then cp -r schema $out/share/cardano-db-sync/; fi
          '';
        };

        # --- midnight-node: pinned pre-built release binary (NOT the Docker image).
        # Deliberate switch: the official Docker image (midnightntwrk/midnight-node:1.0.1)
        # never established stable peer connectivity in this environment across multiple
        # restart attempts -- root cause not fully isolated (candidate: the image's own
        # bundled chain-spec). This exact release binary (same version, same git tag
        # node-1.0.1) was empirically verified to hold real peer connections and sync
        # real blocks once cardano-db-sync caught up to tip. Also bundles the res/
        # directory (chain-specs, genesis files) for every network the release ships,
        # including res/preview/chain-spec-raw.json -- the exact file this environment
        # has verified working.
        midnight-node-bin = pkgs.stdenv.mkDerivation {
          pname = "midnight-node-bin";
          version = "1.0.1";
          src = pkgs.fetchurl {
            url = "https://github.com/midnightntwrk/midnight-node/releases/download/node-1.0.1/midnight-node-1.0.1-linux-amd64.tar.gz";
            sha256 = "7c911f64e16436e1005832f85b5438d9cfe38857825c21297902b563534fecd9";
          };
          sourceRoot = ".";
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.glibc pkgs.gmp pkgs.openssl pkgs.zlib ];
          installPhase = ''
            mkdir -p $out/bin $out/share/midnight-node
            cp midnight-node $out/bin/
            chmod +x $out/bin/midnight-node
            cp -r res $out/share/midnight-node/res
          '';
        };

        # --- Midnight indexer / proof-server: still Docker (unchanged). No upstream
        # flake and no release binary established as working for these two -- unlike
        # midnight-node, they never showed the connectivity problem that motivated
        # switching the node off Docker, so there is no evidence-based reason to change
        # them yet. Revisit if they ever need the same treatment.
        midnightDockerImages = {
          indexer = "midnightntwrk/indexer-standalone:4.3.3@sha256:03afd079b00bcd229df29a24771439c5e7695c339cd89216d0763ce40731cc4b";
          proofServer = "midnightntwrk/proof-server:8.1.0@sha256:801bbc0340e9e96f16735f77b523f23c7459e3359842f7c79c2c53f4e994d531";
        };

        postgresql = pkgs.postgresql_18;

        mkScript = name: text: pkgs.writeShellApplication {
          inherit name text;
          runtimeInputs = [ pkgs.coreutils pkgs.gnutar pkgs.gzip pkgs.rsync postgresql docker cardano-node-bin midnight-node-bin ];
        };

        docker = pkgs.docker;

      in {
        packages = {
          inherit cardano-node-bin cardano-db-sync-bin midnight-node-bin;
          default = cardano-node-bin;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            cardano-node-bin
            cardano-db-sync-bin
            midnight-node-bin
            postgresql
            docker
            pkgs.jq
            pkgs.rsync
          ];
          shellHook = ''
            echo "Midnight dev environment (UmbraDB/nix/midnight-env)"
            echo "  cardano-node:    $(cardano-node --version | head -1)"
            echo "  cardano-db-sync: $(cardano-db-sync --version | head -1)"
            echo "  midnight-node:   $(midnight-node --version | head -1)"
            echo "  postgres:        $(postgres --version)"
            echo
            echo "midnight-node is a compiled binary (not Docker) -- indexer/proof-server still run via Docker."
            echo "Run: nix run .#restore-state   (pull last snapshot before first start)"
            echo "     nix run .#start-stack      (launch full stack)"
            echo "     nix run .#backup-state     (snapshot current progress)"
            echo "     nix run .#stop-stack       (clean shutdown)"
          '';
        };

        apps = {
          backup-state = {
            type = "app";
            program = "${(mkScript "backup-state" (builtins.readFile ./scripts/backup-state.sh))}/bin/backup-state";
          };
          restore-state = {
            type = "app";
            program = "${(mkScript "restore-state" (builtins.readFile ./scripts/restore-state.sh))}/bin/restore-state";
          };
          start-stack = {
            type = "app";
            program = "${(mkScript "start-stack" (builtins.readFile ./scripts/start-stack.sh))}/bin/start-stack";
          };
          stop-stack = {
            type = "app";
            program = "${(mkScript "stop-stack" (builtins.readFile ./scripts/stop-stack.sh))}/bin/stop-stack";
          };
        };
      });
}
