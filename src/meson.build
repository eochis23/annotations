annotations_sources = [
  'main.c',
  'annotations-application.c',
  'annotations-window.c',
]

annotations_deps = [
  dependency('gtk4'),
  dependency('libadwaita-1', version: '>= 1.4'),
]

annotations_sources += gnome.compile_resources('annotations-resources',
  'annotations.gresource.xml',
  c_name: 'annotations'
)

executable('annotations', annotations_sources,
  dependencies: annotations_deps,
       install: true,
)
