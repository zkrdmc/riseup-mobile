Pod::Spec.new do |s|
  s.name           = 'RiseupRecorder'
  s.version        = '0.1.0'
  s.summary        = 'Gapless segmented match recording'
  s.description    = 'One encoder per match; the file rolls at a keyframe every segmentSeconds.'
  s.author         = 'RiseUp'
  s.homepage       = 'https://riseupai.co'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES'
  }

  s.source_files = "**/*.{h,m,swift}"
end
