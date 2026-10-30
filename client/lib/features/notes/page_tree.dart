import 'package:flutter/material.dart' hide Page;
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../data/db/database.dart';
import '../../data/providers.dart';

/// The page tree shown in the sidebar (wide) or drawer (narrow), with search.
class PageTree extends ConsumerStatefulWidget {
  const PageTree({super.key});

  @override
  ConsumerState<PageTree> createState() => _PageTreeState();
}

class _PageTreeState extends ConsumerState<PageTree> {
  final _search = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final pages = ref.watch(pagesProvider).value ?? const <Page>[];
    final repo = ref.read(notesRepositoryProvider);
    final searching = _query.trim().isNotEmpty;
    final results = searching
        ? ref.watch(searchResultsProvider(_query)).value ?? const <Page>[]
        : const <Page>[];

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
                PopupMenuButton<String>(
                  tooltip: 'More',
                  onSelected: (value) async {
                    if (value == 'import') await _importFromClipboard(context);
                  },
                  itemBuilder: (_) => const [
                    PopupMenuItem(
                      value: 'import',
                      child: Text('Import Markdown from clipboard'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: TextField(
              controller: _search,
              decoration: InputDecoration(
                isDense: true,
                hintText: 'Search',
                prefixIcon: const Icon(Icons.search, size: 18),
                suffixIcon: searching
                    ? IconButton(
                        tooltip: 'Clear search',
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () => setState(() {
                          _search.clear();
                          _query = '';
                        }),
                      )
                    : null,
                border: OutlineInputBorder(borderRadius: BorderRadius.circular(8)),
              ),
              onChanged: (value) => setState(() => _query = value),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: searching
                ? _results(context, results)
                : ListView(
                    children: [
                      for (final root in pages.where((p) => p.parentId == null))
                        ..._branch(context, pages, root, 0),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _results(BuildContext context, List<Page> results) {
    if (results.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Text('No matching pages'),
      );
    }
    return ListView(
      children: [
        for (final page in results)
          ListTile(
            dense: true,
            leading: const Icon(Icons.description_outlined, size: 18),
            title: Text(_title(page), overflow: TextOverflow.ellipsis),
            onTap: () => _open(context, page.id),
          ),
      ],
    );
  }

  List<Widget> _branch(BuildContext context, List<Page> all, Page page, int depth) {
    final selected = GoRouterState.of(context).pathParameters['id'] == page.id;
    return [
      ListTile(
        dense: true,
        selected: selected,
        contentPadding: EdgeInsets.only(left: 16.0 + depth * 16, right: 8),
        leading: const Icon(Icons.description_outlined, size: 18),
        title: Text(_title(page), overflow: TextOverflow.ellipsis),
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
        ..._branch(context, all, child, depth + 1),
    ];
  }

  Future<void> _importFromClipboard(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text ?? '';
    if (text.trim().isEmpty) {
      messenger.showSnackBar(const SnackBar(content: Text('Clipboard is empty')));
      return;
    }
    final id = await ref.read(notesRepositoryProvider).importMarkdown(text);
    if (context.mounted) _open(context, id);
    messenger.showSnackBar(const SnackBar(content: Text('Imported page from Markdown')));
  }

  String _title(Page page) => page.title.isEmpty ? 'Untitled' : page.title;

  void _open(BuildContext context, String id) {
    Scaffold.maybeOf(context)?.closeDrawer();
    context.go('/page/$id');
  }
}
