import 'package:appflowy_editor/appflowy_editor.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'theme.dart';

/// Editor style derived from the app theme. The editor's built-in defaults
/// use black text regardless of brightness, so colors must come from here.
EditorStyle editorStyleFor(ThemeData theme, {required bool wide}) {
  final fg = theme.colorScheme.onSurface;
  final padding = EdgeInsets.symmetric(horizontal: wide ? 48 : 16, vertical: 8);
  final selection = ElsiColors.accent.withValues(alpha: 0.25);

  final text = TextStyleConfiguration(
    text: GoogleFonts.inter(fontSize: 16, color: fg),
    href: const TextStyle(
      color: ElsiColors.accent,
      decoration: TextDecoration.underline,
    ),
    code: GoogleFonts.jetBrainsMono(
      fontSize: 14,
      color: ElsiColors.accent,
      backgroundColor: fg.withValues(alpha: 0.08),
    ),
    autoComplete: TextStyle(color: fg.withValues(alpha: 0.4)),
  );

  return wide
      ? EditorStyle.desktop(
          padding: padding,
          cursorColor: ElsiColors.accent,
          selectionColor: selection,
          textStyleConfiguration: text,
        )
      : EditorStyle.mobile(
          padding: padding,
          cursorColor: ElsiColors.accent,
          dragHandleColor: ElsiColors.accent,
          selectionColor: selection,
          textStyleConfiguration: text,
        );
}
