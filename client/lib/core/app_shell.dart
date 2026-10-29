import 'package:flutter/material.dart';

/// Width at which the layout switches from phone navigation to a sidebar.
const double kWideBreakpoint = 840;

/// Responsive shell: sidebar + content on wide screens, content with a
/// drawer on narrow ones. The page tree is written once and reused.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.sidebar, required this.child});

  final Widget sidebar;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth >= kWideBreakpoint) {
          return Scaffold(
            body: Row(
              children: [
                SizedBox(width: 280, child: sidebar),
                const VerticalDivider(width: 1),
                Expanded(child: child),
              ],
            ),
          );
        }
        return Scaffold(
          appBar: AppBar(title: const Text('ElSi')),
          drawer: Drawer(child: sidebar),
          body: child,
        );
      },
    );
  }
}
