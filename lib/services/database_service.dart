import 'dart:convert';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:sqflite/sqflite.dart';
import 'package:path/path.dart' as p;

/// Кросс-платформенное хранилище чатов:
/// - На Windows/Android/Linux/macOS — SQLite (sqflite)
/// - В веб-версии — localStorage через shared_preferences
class DatabaseService {
  static Database? _database;

  // ===== Веб-хранилище (localStorage) =====
  static const String _webChatsKey = 'web_chats';
  static const String _webMessagesKey = 'web_messages';
  List<Map<String, dynamic>>? _webChats;
  List<Map<String, dynamic>>? _webMessages;
  int _nextChatId = 1;
  int _nextMessageId = 1;

  bool get _isWeb => kIsWeb;

  // ===== Публичный API =====

  Future<int> createChat(String name) async {
    if (_isWeb) return _webCreateChat(name);
    final db = await database;
    return await db.insert('chats', {'name': name});
  }

  Future<List<Map<String, dynamic>>> getChats() async {
    if (_isWeb) return _webGetChats();
    final db = await database;
    return await db.query('chats', orderBy: 'created_at DESC');
  }

  Future<void> deleteChat(int chatId) async {
    if (_isWeb) return _webDeleteChat(chatId);
    final db = await database;
    await db.delete('messages', where: 'chat_id = ?', whereArgs: [chatId]);
    await db.delete('chats', where: 'id = ?', whereArgs: [chatId]);
  }

  Future<int> addMessage(int chatId, String role, String content) async {
    if (_isWeb) return _webAddMessage(chatId, role, content);
    final db = await database;
    return await db.insert('messages', {
      'chat_id': chatId,
      'role': role,
      'content': content,
    });
  }

  Future<List<Map<String, dynamic>>> getMessages(int chatId) async {
    if (_isWeb) return _webGetMessages(chatId);
    final db = await database;
    return await db.query(
      'messages',
      where: 'chat_id = ?',
      whereArgs: [chatId],
      orderBy: 'created_at ASC',
    );
  }

  Future<void> updateChatName(int chatId, String name) async {
    if (_isWeb) {
      final chats = await _loadWebChats();
      for (final chat in chats) {
        if (chat['id'] == chatId) chat['name'] = name;
      }
      await _saveWebChats(chats);
      return;
    }
    final db = await database;
    await db.update(
      'chats',
      {'name': name},
      where: 'id = ?',
      whereArgs: [chatId],
    );
  }

  Future<void> close() async {
    if (_isWeb) return;
    final db = await database;
    await db.close();
    _database = null;
  }

  // ===== SQLite (нативные платформы) =====

  Future<Database> get database async {
    if (_database != null) return _database!;
    _database = await _initDatabase();
    return _database!;
  }

  Future<Database> _initDatabase() async {
    final dbPath = await getDatabasesPath();
    final path = p.join(dbPath, 'ai_agent.db');

    return await openDatabase(
      path,
      version: 1,
      onCreate: (db, version) async {
        await db.execute('''
          CREATE TABLE chats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        ''');

        await db.execute('''
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
          )
        ''');
      },
    );
  }

  // ===== Веб-реализация (localStorage) =====

  Future<List<Map<String, dynamic>>> _loadWebChats() async {
    if (_webChats != null) return _webChats!;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_webChatsKey);
    if (raw == null) {
      _webChats = [];
    } else {
      _webChats = (jsonDecode(raw) as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      for (final chat in _webChats!) {
        final id = chat['id'] as int;
        if (id >= _nextChatId) _nextChatId = id + 1;
      }
    }
    return _webChats!;
  }

  Future<void> _saveWebChats(List<Map<String, dynamic>> chats) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_webChatsKey, jsonEncode(chats));
  }

  Future<List<Map<String, dynamic>>> _loadWebMessages() async {
    if (_webMessages != null) return _webMessages!;
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_webMessagesKey);
    if (raw == null) {
      _webMessages = [];
    } else {
      _webMessages = (jsonDecode(raw) as List)
          .map((e) => Map<String, dynamic>.from(e as Map))
          .toList();
      for (final msg in _webMessages!) {
        final id = msg['id'] as int;
        if (id >= _nextMessageId) _nextMessageId = id + 1;
      }
    }
    return _webMessages!;
  }

  Future<void> _saveWebMessages(List<Map<String, dynamic>> messages) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_webMessagesKey, jsonEncode(messages));
  }

  Future<int> _webCreateChat(String name) async {
    final chats = await _loadWebChats();
    final id = _nextChatId++;
    chats.insert(0, {
      'id': id,
      'name': name,
      'created_at': DateTime.now().toIso8601String(),
    });
    await _saveWebChats(chats);
    return id;
  }

  Future<List<Map<String, dynamic>>> _webGetChats() async {
    final chats = await _loadWebChats();
    final sorted = [...chats];
    sorted.sort((a, b) => (b['created_at'] as String)
        .compareTo(a['created_at'] as String));
    return sorted;
  }

  Future<void> _webDeleteChat(int chatId) async {
    final chats = await _loadWebChats();
    chats.removeWhere((c) => c['id'] == chatId);
    await _saveWebChats(chats);

    final messages = await _loadWebMessages();
    messages.removeWhere((m) => m['chat_id'] == chatId);
    await _saveWebMessages(messages);
  }

  Future<int> _webAddMessage(int chatId, String role, String content) async {
    final messages = await _loadWebMessages();
    final id = _nextMessageId++;
    messages.add({
      'id': id,
      'chat_id': chatId,
      'role': role,
      'content': content,
      'created_at': DateTime.now().toIso8601String(),
    });
    await _saveWebMessages(messages);
    return id;
  }

  Future<List<Map<String, dynamic>>> _webGetMessages(int chatId) async {
    final messages = await _loadWebMessages();
    final result =
        messages.where((m) => m['chat_id'] == chatId).toList();
    result.sort((a, b) =>
        (a['created_at'] as String).compareTo(b['created_at'] as String));
    return result;
  }
}
