import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Design tokens shared with the ElSi website.
class ElsiColors {
  static const accent = Color(0xFF10B981);

  static const lightBg = Color(0xFFF4F3EF);
  static const lightFg = Color(0xFF111111);
  static const lightMuted = Color(0xFF5E5D58);

  static const darkBg = Color(0xFF0D0E10);
  static const darkFg = Color(0xFFF4F3EF);

  static const stone = Color(0xFFE7E5DC);
}

/// Expo-out easing used for motion across the app.
const elsiEase = Cubic(0.16, 1, 0.3, 1);

ThemeData _build(Brightness brightness) {
  final dark = brightness == Brightness.dark;
  final bg = dark ? ElsiColors.darkBg : ElsiColors.lightBg;
  final fg = dark ? ElsiColors.darkFg : ElsiColors.lightFg;

  final scheme = ColorScheme.fromSeed(
    seedColor: ElsiColors.accent,
    brightness: brightness,
  ).copyWith(primary: ElsiColors.accent, surface: bg, onSurface: fg);

  final base = ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: bg,
  );

  final body = GoogleFonts.interTextTheme(base.textTheme).apply(
    bodyColor: fg,
    displayColor: fg,
  );
  final display = GoogleFonts.plusJakartaSans;

  return base.copyWith(
    textTheme: body.copyWith(
      headlineMedium: display(textStyle: body.headlineMedium, fontWeight: FontWeight.w700),
      titleLarge: display(textStyle: body.titleLarge, fontWeight: FontWeight.w600),
      labelSmall: GoogleFonts.jetBrainsMono(textStyle: body.labelSmall),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: bg,
      foregroundColor: fg,
      elevation: 0,
      scrolledUnderElevation: 0,
    ),
  );
}

final ThemeData elsiLightTheme = _build(Brightness.light);
final ThemeData elsiDarkTheme = _build(Brightness.dark);
