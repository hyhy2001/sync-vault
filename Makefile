# sync-vault — local install Makefile.
# Everything stays local: no root, no /etc, no system-wide installs.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Where `make install` drops the binary + config. Override with: make install PREFIX=/path
PREFIX ?= $(CURDIR)/sync-vault
TARGET ?= bun-linux-x64
BIN    := dist/sync-vault

# Bun installs LOCALLY into the project (no root, no system-wide) so a fresh
# machine can bootstrap itself. A system `bun` on PATH still takes precedence.
BUN_LOCAL := $(CURDIR)/.bun
export PATH := $(BUN_LOCAL)/bin:$(PATH)

.PHONY: help bun deps build install all check test typecheck lint clean

help: ## Show this help
	@echo "sync-vault — local build & install"
	@echo
	@echo "Targets:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "Install location (PREFIX): $(PREFIX)"

bun: ## Install Bun locally into ./.bun if not already on PATH
	@if command -v bun >/dev/null 2>&1; then \
		echo "bun already available: $$(command -v bun)"; \
	else \
		echo "Installing Bun locally into $(BUN_LOCAL)…"; \
		curl -fsSL https://bun.sh/install | BUN_INSTALL="$(BUN_LOCAL)" bash; \
		echo "Bun installed: $(BUN_LOCAL)/bin/bun"; \
	fi

deps: bun ## Install dependencies with bun
	bun install

build: deps ## Build the single self-contained binary into dist/
	bash scripts/build.sh $(TARGET)

install: build ## Build then install binary + config into PREFIX (local, no root)
	bash scripts/install.sh "$(PREFIX)"

all: install ## Alias for `install` (deps -> build -> install)

check: typecheck lint test ## Run typecheck, lint, and tests

typecheck: ## Type-check with tsc
	bun run typecheck

lint: ## Lint with biome
	bun run lint

test: ## Run the unit test suite
	bun test

clean: ## Remove build artifacts and node_modules
	rm -rf dist node_modules
