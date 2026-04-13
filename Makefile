# Pack GNOME Shell extension zip (schemas + optional native helper).
UUID = annotations@eochis23.github.io
NATIVE = native

.PHONY: schemas native pack test-motion

schemas:
	glib-compile-schemas schemas/

native:
	cd $(NATIVE) && (meson setup build --reconfigure 2>/dev/null || meson setup build) && meson compile -C build

test-motion: native
	python3 $(NATIVE)/test-scroll.py

pack: schemas native
	mkdir -p bin
	cp -f $(NATIVE)/build/anno-motion bin/anno-motion
	gnome-extensions pack --force \
	  --extra-source=prefs.js \
	  --extra-source=stylesheet.css \
	  --extra-source=lib/strokes.js \
	  --extra-source=lib/devices.js \
	  --extra-source=lib/motionClient.js \
	  --extra-source=lib/motionSync.js \
	  --extra-source=lib/overlaySession.js \
	  --extra-source=lib/annoDebug.js \
	  --extra-source=schemas/gschemas.compiled \
	  --extra-source=schemas/org.gnome.shell.extensions.annotations.gschema.xml \
	  --extra-source=bin/anno-motion \
	  .
	@echo "Built $(UUID).shell-extension.zip"
