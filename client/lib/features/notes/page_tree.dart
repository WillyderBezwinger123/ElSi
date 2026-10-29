import 'package:flutter/material.dart';

/// Placeholder page tree. Replaced by the drift-backed tree in M1.
class PageTree extends StatelessWidget {
  const PageTree({super.key});

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text('ElSi', style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 16),
          const ListTile(leading: Icon(Icons.note_outlined), title: Text('Notes')),
          const ListTile(leading: Icon(Icons.chat_bubble_outline), title: Text('Chat')),
          const ListTile(leading: Icon(Icons.auto_awesome_outlined), title: Text('Assistant')),
        ],
      ),
    );
  }
}
