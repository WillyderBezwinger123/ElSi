import 'package:elsi/ui_tokens/editor_style.dart';
import 'package:elsi/ui_tokens/theme.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('editor text follows the theme in light and dark mode', () {
    for (final theme in [elsiLightTheme, elsiDarkTheme]) {
      for (final wide in [true, false]) {
        final style = editorStyleFor(theme, wide: wide);
        expect(style.textStyleConfiguration.text.color, theme.colorScheme.onSurface);
        expect(style.textStyleConfiguration.text.color, isNot(theme.scaffoldBackgroundColor));
      }
    }
    expect(editorStyleFor(elsiDarkTheme, wide: true).textStyleConfiguration.text.color,
        ElsiColors.darkFg);
  });
}
