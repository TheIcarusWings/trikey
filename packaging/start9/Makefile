# Builds trikey-guardian.s9pk with the StartOS SDK.
#
# TODO(verify): the current template runs `include s9pk.mk` from a shared file copied
# from start-sdk. This Makefile calls `start-sdk pack` directly because that file could
# not be fetched. Replace the recipes with the template's s9pk.mk, and confirm the output
# file name and the verify subcommand, before relying on this.

PKG_ID := trikey-guardian
S9PK := $(PKG_ID).s9pk
SOURCES := $(shell find startos -name '*.ts' 2>/dev/null)

.DELETE_ON_ERROR:
.PHONY: all verify clean

all: $(S9PK)

$(S9PK): $(SOURCES)
	start-sdk pack

verify: $(S9PK)
	start-sdk verify s9pk $(S9PK)

clean:
	rm -f $(S9PK)
