annotations_sources = [
  'main.c',
  'annotations-application.c',
  'annotations-window.c',
]

annotations_deps = [
  dependency('gtk4'),
  dependency('libadwaita-1', version: '>= 1.4'),
]

x11_dep = dependency('x11', required: false)
if x11_dep.found()
  annotations_deps += x11_dep
endif

annotations_c_args = []

annotations_sources += gnome.compile_resources('annotations-resources',
  'annotations.gresource.xml',
  c_name: 'annotations'
)

executable('annotations', annotations_sources,
  dependencies: annotations_deps,
            c_args: annotations_c_args,
       install: true,
)
