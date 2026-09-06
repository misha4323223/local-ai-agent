class Chat {
  final int? id;
  final String name;
  final DateTime createdAt;

  Chat({
    this.id,
    required this.name,
    DateTime? createdAt,
  }) : createdAt = createdAt ?? DateTime.now();

  /// Create from database map
  factory Chat.fromMap(Map<String, dynamic> map) {
    return Chat(
      id: map['id'],
      name: map['name'],
      createdAt: DateTime.parse(map['created_at']),
    );
  }

  /// Convert to map for database
  Map<String, dynamic> toMap() {
    return {
      'id': id,
      'name': name,
      'created_at': createdAt.toIso8601String(),
    };
  }

  /// Create a copy with optional parameters
  Chat copyWith({
    int? id,
    String? name,
    DateTime? createdAt,
  }) {
    return Chat(
      id: id ?? this.id,
      name: name ?? this.name,
      createdAt: createdAt ?? this.createdAt,
    );
  }
}
