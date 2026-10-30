import 'package:flutter/material.dart' hide Page;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/db/database.dart';
import '../../data/providers.dart';

/// The page tree shown in the sidebar (wide) or drawer (narrow).
class PageTree extends ConsumerWidget {
  const PageTree({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final pages = ref.watch(pagesProvider).value ?? const <Page>[];
    final repo = ref.read(notesRepositoryProvider);

    return SafeArea(
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 8, 8),
            child: Row(
              children: [
                Expanded(
                  child: Text('ElSi', style: Theme.of(context).textTheme.titleLarge),
                ),
                IconButton(
                  tooltip: 'New page',
                  icon: const Icon(Icons.add),
                  onPressed: () async {
                    final id = await repo.createPage();
                    if (context.mounted) _open(context, id);
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              children: [
                for (final root in pages.where((p) => p.parentId == null))
                  ..._branch(context, ref, pages, root, 0),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<Widget> _branch(
    BuildContext context,
    WidgetRef ref,
    List<Page> all,
    Page page,
    int depth,
  ) {
    final selected = GoRouterState.of(context).pathParameters['id'] == page.id;
    return [
      ListTile(
        dense: true,
        selected: selected,
        contentPadding: EdgeInsets.only(left: 16.0 + depth * 16, right: 8),
        leading: const Icon(Icons.description_outlined, size: 18),
        title: Text(
          page.title.isEmpty ? 'Untitled' : page.title,
          overflow: TextOverflow.ellipsis,
        ),
        onTap: () => _open(context, page.id),
        trailing: PopupMenuButton<String>(
          onSelected: (value) async {
            final repo = ref.read(notesRepositoryProvider);
            if (value == 'child') {
              final id = await repo.createPage(parentId: page.id);
              if (context.mounted) _open(context, id);
            } else if (value == 'delete') {
              await repo.deletePage(page.id);
              if (selected && context.mounted) context.go('/');
            }
          },
          itemBuilder: (_) => const [
            PopupMenuItem(value: 'child', child: Text('Add subpage')),
            PopupMenuItem(value: 'delete', child: Text('Delete')),
          ],
        ),
      ),
      for (final child in all.where((p) => p.parentId == page.id))
        ..._branch(context, ref, all, child, depth + 1),
    ];
  }

  void _open(BuildContext context, String id) {
    Scaffold.maybeOf(context)?.closeDrawer();
    context.go('/page/$id');
  }
}
