import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/app_shell.dart';
import 'features/notes/editor_page.dart';
import 'features/notes/page_tree.dart';
import 'ui_tokens/theme.dart';

void main() {
  runApp(const ProviderScope(child: ElsiApp()));
}

final _router = GoRouter(
  routes: [
    ShellRoute(
      builder: (context, state, child) =>
          AppShell(sidebar: const PageTree(), child: child),
      routes: [
        GoRoute(
          path: '/',
          builder: (context, state) =>
              const Center(child: Text('Select or create a page')),
        ),
        GoRoute(
          path: '/page/:id',
          builder: (context, state) =>
              EditorPage(pageId: state.pathParameters['id']!),
        ),
      ],
    ),
  ],
);

class ElsiApp extends StatelessWidget {
  const ElsiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp.router(
      title: 'ElSi',
      theme: elsiLightTheme,
      darkTheme: elsiDarkTheme,
      routerConfig: _router,
    );
  }
}
