# Model Viewer - exports the SketchUp model for the Model Viewer phone app (.glb with scenes,
# tags and object names) and serves it to the phone over Wi-Fi.
require 'sketchup.rb'
require 'extensions.rb'

module ModelViewer
  VERSION = '1.0.0'.freeze

  unless file_loaded?(__FILE__)
    ext = SketchupExtension.new('Model Viewer', 'modelviewer/main')
    ext.description = 'Export the model for the Model Viewer phone app (scenes, tags, object names, ' \
                      'materials) and send it to the phone over Wi-Fi.'
    ext.version = VERSION
    ext.creator = 'Lucie'
    Sketchup.register_extension(ext, true)
    file_loaded(__FILE__)
  end
end
