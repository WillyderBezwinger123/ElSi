import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import 'core/app_shell.dart';
import 'features/notes/page_tree.dart';
import 'ui_tokens/theme.dart';

void main() {
  runApp(const ProviderScope(child: ElsiApp()));
}

final _router = GoRouter(
  routes: [
    GoRoute(
      path: '/',
      builder: (context, state) => const AppShell(
        sidebar: PageTree(),
        child: Center(child: Text('Select or create a page')),
      ),
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
