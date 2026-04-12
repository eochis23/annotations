annotations_sources = [
  'main.c',
  'annotations-application.c',
  'annotations-window.c',
]

annotations_deps = [
  dependency('gtk4'),
  dependency('libadwaita-1', version: '>= 1.4'),
]

gtk4_layer_shell_dep = dependency('gtk4-layer-shell', required: false)
annotations_deps += gtk4_layer_shell_dep

x11_dep = dependency('x11', required: false)
if x11_dep.found()
  annotations_deps += x11_dep
endif

annotations_c_args = []
if gtk4_layer_shell_dep.found()
  annotations_c_args += '-DHAVE_GTK4_LAYER_SHELL=1'
endif

annotations_sources += gnome.compile_resources('annotations-resources',
  'annotations.gresource.xml',
  c_name: 'annotations'
)

executable('annotations', annotations_sources,
  dependencies: annotations_deps,
            c_args: annotations_c_args,
       install: true,
)
