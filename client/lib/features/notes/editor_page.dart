import 'dart:async';

import 'package:appflowy_editor/appflowy_editor.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/app_shell.dart';
import '../../data/providers.dart';
import '../../ui_tokens/editor_style.dart';

/// Editor for one page. Loads blocks from the database and autosaves them
/// shortly after the last edit.
class EditorPage extends ConsumerStatefulWidget {
  const EditorPage({super.key, required this.pageId});

  final String pageId;

  @override
  ConsumerState<EditorPage> createState() => _EditorPageState();
}

class _EditorPageState extends ConsumerState<EditorPage> {
  static const _saveDelay = Duration(milliseconds: 800);

  late final _repo = ref.read(notesRepositoryProvider);
  EditorState? _editor;
  StreamSubscription<EditorTransactionValue>? _sub;
  Timer? _saveTimer;
  final _title = TextEditingController();
  Timer? _titleTimer;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(EditorPage old) {
    super.didUpdateWidget(old);
    if (old.pageId != widget.pageId) {
      _flush(old.pageId);
      _load();
    }
  }

  Future<void> _load() async {
    final repo = _repo;
    final pageId = widget.pageId;
    await _sub?.cancel();
    setState(() => _editor = null);

    final page = await repo.getPage(pageId);
    final doc = await repo.loadDocument(pageId);
    if (!mounted || pageId != widget.pageId) return;

    final editor = EditorState(document: doc);
    _sub = editor.transactionStream.listen((_) {
      _saveTimer?.cancel();
      _saveTimer = Timer(_saveDelay, () => _save(pageId, editor));
    });
    _title.text = page?.title ?? '';
    setState(() => _editor = editor);
  }

  Future<void> _save(String pageId, EditorState editor) {
    return _repo.saveDocument(pageId, editor.document);
  }

  void _flush(String pageId) {
    final editor = _editor;
    if (_saveTimer?.isActive ?? false) {
      _saveTimer!.cancel();
      if (editor != null) _save(pageId, editor);
    }
    if (_titleTimer?.isActive ?? false) {
      _titleTimer!.cancel();
      _repo.renamePage(pageId, _title.text);
    }
  }

  @override
  void dispose() {
    _flush(widget.pageId);
    _sub?.cancel();
    _title.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final editor = _editor;
    if (editor == null) return const Center(child: CircularProgressIndicator());

    final wide = MediaQuery.sizeOf(context).width >= kWideBreakpoint;
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(wide ? 48 : 16, 24, 16, 0),
          child: TextField(
            controller: _title,
            style: theme.textTheme.headlineMedium,
            decoration: const InputDecoration(
              hintText: 'Untitled',
              border: InputBorder.none,
            ),
            onChanged: (value) {
              _titleTimer?.cancel();
              _titleTimer = Timer(_saveDelay, () {
                _repo.renamePage(widget.pageId, value);
              });
            },
          ),
        ),
        Expanded(
          child: AppFlowyEditor(
            key: ValueKey(widget.pageId),
            editorState: editor,
            editorStyle: editorStyleFor(theme, wide: wide),
          ),
        ),
      ],
    );
  }
}
