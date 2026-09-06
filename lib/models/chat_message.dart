class ChatMessage {
  final int? id;
  final int chatId;
  final String role; // 'user', 'assistant', 'tool'
  final String content;
  final DateTime createdAt;

  ChatMessage({
    this.id,
    required this.chatId,
    required this.role,
    required this.content,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  /// Create from database map
  factory ChatMessage.fromMap(Map<String, dynamic> map) {
    return ChatMessage(
      id: map['id'],
      chatId: map['chat_id'],
      role: map['role'],
      content: map['content'],
      createdAt: DateTime.parse(map['created_at']),
    );
  }

  /// Convert to map for database
  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'chat_id': chatId,
      'role': role,
      'content': content,
      'created_at': createdAt.toIso8601String(),
    };
  }

  /// Create a copy with optional parameters
  ChatMessage copyWith({
    int? id,
    int? chatId,
    String? role,
    String? content,
    DateTime? createdAt,
  }) {
    return ChatMessage(
      id: id ?? this.id,
      chatId: chatId ?? this.chatId,
      role: role ?? this.role,
      content: content ?? this.content,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}
