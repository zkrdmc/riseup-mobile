Pod::Spec.new do |s|
  s.name           = 'RiseupVision'
  s.version        = '0.1.0'
  s.summary        = 'OpenCV calib3d: chessboard calibration and homography'
  s.description    = 'Lens calibration (PRD 4.3) and the pitch homography solve (PRD 4.2).'
  s.author         = 'RiseUp'
  s.homepage       = 'https://riseupai.co'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # ══════════════════════════════════════════════════════════════════════════
  #  OpenCV, and it MUST be a build that includes calib3d.
  # ══════════════════════════════════════════════════════════════════════════
  #
  # This is the entire reason this module exists rather than using
  # `react-native-fast-opencv`, which depends on the trimmed `FastOpenCV-iOS`
  # pod and says so in its own source: "cv::findHomography needs calib3d, which
  # is not in the iOS pod". Everything the product needs — findChessboardCorners,
  # calibrateCamera, findHomography — lives in that one module.
  #
  # VERIFY THIS ON THE FIRST BUILD. Call `getOpenCvVersion()` and then run one
  # `findHomography` on four synthetic points. If calib3d is missing, the link
  # fails at build time with undefined symbols, which is the good outcome; what
  # must not happen is shipping a build where these paths were never exercised.
  #
  # The `OpenCV` spec carries the full framework. It is not the newest OpenCV
  # release — check `pod search OpenCV` and prefer a current XCFramework
  # distribution if one is available to the project, keeping the version pinned
  # either way.
  s.dependency 'OpenCV', '~> 4.3.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # OpenCV headers are C++, so every translation unit that sees them has to
    # be compiled as Objective-C++. The bridge below is `.mm` for this reason;
    # the Swift file never includes an OpenCV header.
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++17',
    'CLANG_CXX_LIBRARY' => 'libc++'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
