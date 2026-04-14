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
	# Pass directories for lib/, schemas/, bin/ — listing lib/*.js flattens basenames and breaks ./lib/… imports.
	gnome-extensions pack --force \
	  --extra-source=prefs.js \
	  --extra-source=stylesheet.css \
	  --extra-source=lib \
	  --extra-source=schemas \
	  --extra-source=bin \
	  .
	# Pack omits schemas/gschemas.compiled; settings need it under schemas/ in the zip.
	zip -q -u $(UUID).shell-extension.zip schemas/gschemas.compiled
	@echo "Built $(UUID).shell-extension.zip"
