#!/bin/bash
cd "$(dirname "$0")"

if [ ! -f "node/bin/node" ]; then
    echo "Node.js not found, downloading..."
    rm -rf node node.tar.gz node.tar.xz

    OS=$(uname -s)
    ARCH=$(uname -m)
    NODE_VER="v18.20.4"

    if [ "$OS" = "Linux" ]; then
        if [ "$ARCH" = "aarch64" ]; then
            URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-arm64.tar.xz"
        else
            URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
        fi
        curl -L -o node.tar.xz "$URL"
        tar -xf node.tar.xz
        mv node-${NODE_VER}-linux-* node
        rm node.tar.xz
    elif [ "$OS" = "Darwin" ]; then
        if [ "$ARCH" = "arm64" ]; then
            URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-arm64.tar.gz"
        else
            URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-darwin-x64.tar.gz"
        fi
        curl -L -o node.tar.gz "$URL"
        tar -xf node.tar.gz
        mv node-${NODE_VER}-darwin-* node
        rm node.tar.gz
    else
        echo "Unsupported OS: $OS"
        exit 1
    fi
    echo
fi

NODE="node/bin/node"
NPM_CLI="node/lib/node_modules/npm/bin/npm-cli.js"
NPX_CLI="node/lib/node_modules/npm/bin/npx-cli.js"
export PATH="$(pwd)/node/bin:$PATH"
export CI=1

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    "$NODE" "$NPM_CLI" install
fi

echo "Building music-key-server..."

OS=$(uname -s)
ARCH=$(uname -m)
if [ "$OS" = "Linux" ]; then
    if [ "$ARCH" = "aarch64" ]; then
        TARGET="node18-linux-arm64"
        OUTPUT="dist/music-key-server-linux-arm64"
    else
        TARGET="node18-linux-x64"
        OUTPUT="dist/music-key-server-linux-x64"
    fi
elif [ "$OS" = "Darwin" ]; then
    if [ "$ARCH" = "arm64" ]; then
        TARGET="node18-macos-arm64"
        OUTPUT="dist/music-key-server-macos-arm64"
    else
        TARGET="node18-macos-x64"
        OUTPUT="dist/music-key-server-macos-x64"
    fi
else
    TARGET="node18-linux-x64"
    OUTPUT="dist/music-key-server"
fi

"$NODE" "$NPX_CLI" pkg . --target "$TARGET" --output "$OUTPUT"

echo
echo "Done! Output: $OUTPUT"
