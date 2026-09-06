import 'package:flutter/material.dart';
import '../models/chat_message.dart';

class MessageBubble extends StatelessWidget {
  final ChatMessage message;

  const MessageBubble({super.key, required this.message});

  @override
  Widget build(BuildContext context) {
    final isUser = message.role == 'user';
    final isTool = message.role == 'tool';

    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            CircleAvatar(
              backgroundColor: isTool
                  ? Theme.of(context).colorScheme.tertiary
                  : Theme.of(context).colorScheme.primary,
              child: Icon(
                isTool ? Icons.build : Icons.smart_toy,
                color: Colors.white,
                size: 20,
              ),
            ),
            const SizedBox(width: 12),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: isUser
                    ? Theme.of(context).colorScheme.primary
                    : isTool
                        ? Theme.of(context).colorScheme.tertiaryContainer
                        : Theme.of(context).colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(12),
                  topRight: const Radius.circular(12),
                  bottomLeft: Radius.circular(isUser ? 12 : 0),
                  bottomRight: Radius.circular(isUser ? 0 : 12),
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withOpacity(0.05),
                    blurRadius: 4,
                    offset: const Offset(0, 2),
                  ),
                ],
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (isTool)
                    Container(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Row(
                        children: [
                          Icon(
                            Icons.build,
                            size: 12,
                            color: Theme.of(context).colorScheme.onTertiaryContainer,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            'Результат инструмента',
                            style: Theme.of(context).textTheme.labelSmall?.copyWith(
                              color: Theme.of(context).colorScheme.onTertiaryContainer,
                            ),
                          ),
                        ],
                      ),
                    ),
                  SelectableText(
                    message.content,
                    style: TextStyle(
                      color: isUser
                          ? Theme.of(context).colorScheme.onPrimary
                          : Theme.of(context).colorScheme.onSurface,
                      fontFamily: isTool ? 'monospace' : null,
                      fontSize: isTool ? 12 : null,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (isUser) ...[
            const SizedBox(width: 12),
            CircleAvatar(
              backgroundColor: Theme.of(context).colorScheme.primary,
              child: const Icon(
                Icons.person,
                color: Colors.white,
                size: 20,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
