/// Hybrid logical clock. Values are fixed-width strings so plain string
/// comparison orders them: `<wallMs>-<counter>-<deviceId>`.
class Hlc {
  Hlc(this.deviceId);

  final String deviceId;
  int _wallMs = 0;
  int _counter = 0;

  String now() {
    final wall = DateTime.now().millisecondsSinceEpoch;
    if (wall > _wallMs) {
      _wallMs = wall;
      _counter = 0;
    } else {
      _counter++;
    }
    return '${_wallMs.toString().padLeft(15, '0')}-'
        '${_counter.toString().padLeft(5, '0')}-$deviceId';
  }

  /// Advances the clock past a timestamp received from another device.
  void observe(String remote) {
    final parts = remote.split('-');
    if (parts.length < 3) return;
    final wall = int.tryParse(parts[0]) ?? 0;
    final counter = int.tryParse(parts[1]) ?? 0;
    if (wall > _wallMs || (wall == _wallMs && counter >= _counter)) {
      _wallMs = wall;
      _counter = counter;
    }
  }
}
