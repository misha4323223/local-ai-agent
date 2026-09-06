import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/chat_provider.dart';
import '../models/chat.dart';

class Sidebar extends StatelessWidget {
  const Sidebar({super.key});

  @override
  Widget build(BuildContext context) {
    return Drawer(
      child: Column(
        children: [
          // Header
          Container(
            padding: EdgeInsets.only(
              top: MediaQuery.of(context).padding.top + 16,
              bottom: 16,
              left: 16,
              right: 16,
            ),
            decoration: BoxDecoration(
              color: Theme.of(context).colorScheme.primaryContainer,
            ),
            child: Row(
              children: [
                Icon(
                  Icons.code,
                  size: 32,
                  color: Theme.of(context).colorScheme.onPrimaryContainer,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child:                Text(
                  'AI Агент',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      color: Theme.of(context).colorScheme.onPrimaryContainer,
                    ),
                  ),
                ),
              ],
            ),
          ),

          // New chat button
          Padding(
            padding: const EdgeInsets.all(16),
            child: SizedBox(
              width: double.infinity,
              child: FilledButton.icon(
                onPressed: () async {
                  await context.read<ChatProvider>().createChat();
                  if (context.mounted) {
                    Navigator.pop(context);
                  }
                },
                icon: const Icon(Icons.add),
                label: const Text('Новый чат'),
              ),
            ),
          ),

          // Chat list
          Expanded(
            child: Consumer<ChatProvider>(
              builder: (context, provider, _) {
                if (provider.chats.isEmpty) {
                  return const Center(
                    child: Text('Чатов пока нет'),
                  );
                }

                return ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                  itemCount: provider.chats.length,
                  itemBuilder: (context, index) {
                    final chat = provider.chats[index];
                    final isSelected = provider.currentChat?.id == chat.id;

                    return ListTile(
                      leading: Icon(
                        Icons.chat_bubble_outline,
                        color: isSelected
                            ? Theme.of(context).colorScheme.primary
                            : null,
                      ),
                      title: Text(
                        chat.name,
                        style: TextStyle(
                          color: isSelected
                              ? Theme.of(context).colorScheme.primary
                              : null,
                          fontWeight: isSelected ? FontWeight.bold : null,
                        ),
                      ),
                      selected: isSelected,
                      selectedTileColor: Theme.of(context).colorScheme.primaryContainer.withOpacity(0.3),
                      trailing: IconButton(
                        icon: const Icon(Icons.delete_outline, size: 20),
                        onPressed: () async {
                          final confirmed = await showDialog<bool>(
                            context: context,
                            builder: (context) => AlertDialog(
                              title: const Text('Удалить чат'),
                              content: const Text(
                                  'Вы уверены, что хотите удалить этот чат?'),
                              actions: [
                                TextButton(
                                  onPressed: () => Navigator.pop(context, false),
                                  child: const Text('Отмена'),
                                ),
                                TextButton(
                                  onPressed: () => Navigator.pop(context, true),
                                  child: const Text('Удалить'),
                                ),
                              ],
                            ),
                          );
                          if (confirmed == true && context.mounted) {
                            await provider.deleteChat(chat.id!);
                          }
                        },
                      ),
                      onTap: () async {
                        await provider.selectChat(chat);
                        if (context.mounted) {
                          Navigator.pop(context);
                        }
                      },
                    );
                  },
                );
              },
            ),
          ),

          // Footer
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: Theme.of(context).dividerColor,
                ),
              ),
            ),
            child: Row(
              children: [
                Icon(
                  Icons.smart_toy,
                  color: Theme.of(context).colorScheme.onSurface.withOpacity(0.6),
                ),
                const SizedBox(width: 8),
                Text(
                  'Работает на локальном AI',
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurface.withOpacity(0.6),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
