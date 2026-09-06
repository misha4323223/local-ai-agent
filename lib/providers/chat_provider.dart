import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import '../models/chat.dart';
import '../models/chat_message.dart';
import '../services/database_service.dart';
import '../services/ollama_service.dart';
import '../services/tool_service.dart';
import '../services/settings_service.dart';

/// Результат запроса к AI API с поддержкой tool calls
class _ApiResult {
  final String content;
  final List<Map<String, dynamic>> toolCalls;
  final Map<String, dynamic> assistantMessage;

  _ApiResult({
    required this.content,
    required this.toolCalls,
    required this.assistantMessage,
  });
}

class ChatProvider extends ChangeNotifier {
  final DatabaseService _db = DatabaseService();
  final OllamaService _ollama = OllamaService();
  final ToolService _toolService = ToolService();
  final SettingsService _settings = SettingsService();

  List<Chat> _chats = [];
  List<ChatMessage> _currentMessages = [];
  Chat? _currentChat;
  bool _isLoading = false;
  String _systemPrompt = '';

  // Настройки провайдера AI
  String _providerType = SettingsService.providerOllama;
  String _apiUrl = SettingsService.defaultApiUrl;
  String _apiKey = '';
  String _externalModel = SettingsService.defaultExternalModel;

  // Getters
  List<Chat> get chats => _chats;
  List<ChatMessage> get currentMessages => _currentMessages;
  Chat? get currentChat => _currentChat;
  bool get isLoading => _isLoading;
  String get providerType => _providerType;
  bool get isExternal => _providerType == SettingsService.providerExternal;
  SettingsService get settingsService => _settings;

  /// Initialize provider
  Future<void> init() async {
    await _loadSettings();
    await loadChats();
  }

  /// Load settings
  Future<void> _loadSettings() async {
    final settings = await _settings.getAllSettings();
    _ollama.baseUrl = settings['ollamaUrl']!;
    _ollama.model = settings['ollamaModel']!;
    _providerType = settings['providerType']!;
    _apiUrl = settings['apiUrl']!;
    _apiKey = settings['apiKey']!;
    _externalModel = settings['externalModel']!;
    _toolService.setWorkingDirectory(settings['workingDirectory']!);
    _toolService.setGithubToken(settings['githubToken'] ?? '');
    
    _systemPrompt = '''Ты — AI-агент разработчика на имени Ассистент. Ты умеешь:
- Создавать файлы и папки, читать и записывать файлы
- Работать с git-репозиториями (commit, push, pull)

Когда пользователь просит что-то сделать — используй подходящие инструменты,
объясняй, что делаешь, и показывай результат.

ВАЖНО: ВСЕГДА отвечай ТОЛЬКО на русском языке. Ни в коем случае не используй английский язык в ответах. Даже если пользователь написал по-английски — отвечай по-русски. Все названия терминов, описания и объяснения — строго на русском. Кратко и по делу.''';
  }

  /// Get Ollama URL
  Future<String> getOllamaUrl() async {
    return await _settings.getOllamaUrl();
  }

  /// Get Ollama model
  Future<String> getOllamaModel() async {
    return await _settings.getOllamaModel();
  }

  /// Get working directory
  Future<String> getWorkingDirectory() async {
    return await _settings.getWorkingDirectory();
  }

  /// Get external API settings
  Future<Map<String, String>> getApiSettings() async {
    return {
      'providerType': await _settings.getProviderType(),
      'apiUrl': await _settings.getApiUrl(),
      'apiKey': await _settings.getApiKey(),
      'externalModel': await _settings.getExternalModel(),
    };
  }

  /// Load all chats
  Future<void> loadChats() async {
    final chatMaps = await _db.getChats();
    _chats = chatMaps.map((map) => Chat.fromMap(map)).toList();
    notifyListeners();
  }

  /// Create a new chat
  Future<Chat> createChat([String? name]) async {
    final chatName = name ??
        'Чат ${DateTime.now().day}.${DateTime.now().month} ${DateTime.now().hour}:${DateTime.now().minute.toString().padLeft(2, '0')}';
    final id = await _db.createChat(chatName);
    final chat = Chat(id: id, name: chatName);
    _chats.insert(0, chat);
    notifyListeners();
    return chat;
  }

  /// Select a chat
  Future<void> selectChat(Chat chat) async {
    _currentChat = chat;
    final messageMaps = await _db.getMessages(chat.id!);
    _currentMessages = messageMaps.map((map) => ChatMessage.fromMap(map)).toList();
    notifyListeners();
  }

  /// Delete a chat
  Future<void> deleteChat(int chatId) async {
    await _db.deleteChat(chatId);
    _chats.removeWhere((c) => c.id == chatId);
    if (_currentChat?.id == chatId) {
      _currentChat = null;
      _currentMessages = [];
    }
    notifyListeners();
  }

  /// Send a message
  Future<void> sendMessage(String content) async {
    if (_isLoading) return;
    _isLoading = true;
    try {
      if (_currentChat == null) {
        _currentChat = await createChat();
      }

      // Add user message
      final userMsgId = await _db.addMessage(_currentChat!.id!, 'user', content);
      final userMessage = ChatMessage(
        id: userMsgId,
        chatId: _currentChat!.id!,
        role: 'user',
        content: content,
      );
      _currentMessages.add(userMessage);
      notifyListeners();

      // Цикл вызова инструментов: модель → инструменты → результат → модель
      // Используем Map<String, dynamic> потому что tool_calls — список
      var apiMessages = <Map<String, dynamic>>[
        {'role': 'system', 'content': _systemPrompt},
        ..._currentMessages.map((m) => {'role': m.role, 'content': m.content}),
      ];

      const maxToolRounds = 5;
      for (var round = 0; round < maxToolRounds; round++) {
        // Запрос к API с инструментами
        _ApiResult apiResult;
        if (_providerType == SettingsService.providerExternal) {
          apiResult = await _sendExternalWithTools(apiMessages);
        } else {
          apiResult = await _sendOllamaWithTools(apiMessages);
        }

        // Если нет вызовов инструментов — текстовый ответ модели
        if (apiResult.toolCalls.isEmpty) {
          final cleanResponse = _stripThinking(apiResult.content);
          final assistantMsgId = await _db.addMessage(
              _currentChat!.id!, 'assistant', cleanResponse);
          _currentMessages.add(ChatMessage(
            id: assistantMsgId,
            chatId: _currentChat!.id!,
            role: 'assistant',
            content: cleanResponse.isEmpty ? '(пустой ответ)' : cleanResponse,
          ));
          _streamingResponse = null;
          break;
        }

        // Есть вызовы инструментов — добавляем assistant-сообщение с tool_calls
        apiMessages.add(apiResult.assistantMessage);

        // Выполняем каждый tool call
        for (final call in apiResult.toolCalls) {
          final toolName = call['name'] as String;
          final toolCallId = call['id'] as String;
          final toolArgs = call['arguments'] != null
              ? Map<String, dynamic>.from(
                  (call['arguments'] as Map).map((k, v) => MapEntry(k.toString(), v)))
              : <String, dynamic>{};

          // Показываем в чате что инструмент выполняется
          _currentMessages.add(ChatMessage(
            chatId: _currentChat!.id!,
            role: 'assistant',
            content: '🔧 $toolName(${toolArgs.entries.map((e) => '${e.key}="${e.value}"').join(', ')})',
          ));
          notifyListeners();

          final result = await _toolService.executeTool(toolName, toolArgs);

          _currentMessages.add(ChatMessage(
            chatId: _currentChat!.id!,
            role: 'assistant',
            content: '📋 Результат: $result',
          ));
          notifyListeners();

          // Добавляем tool-сообщение С tool_call_id
          apiMessages.add({
            'role': 'tool',
            'tool_call_id': toolCallId,
            'content': '$toolName: $result',
          });
        }
      }

    } catch (e) {
      _streamingResponse = null;
      // Показываем ошибку прямо в чате на русском
      String friendlyError;
      if (e.toString().contains('Failed to connect') ||
          e.toString().contains('Connection refused') ||
          e.toString().contains('SocketException')) {
        friendlyError = '❌ Не удалось подключиться к Ollama.\n\n'
                'Проверь:\n'
                '• Запущен ли Ollama на компьютере (ollama serve)\n'
                '• Правильный URL в настройках\n\n'
                'Или переключись на внешний API (Groq и др.) в настройках.';
      } else if (_providerType == SettingsService.providerExternal) {
        // Показываем реальную ошибку API, чтобы было видно, что именно не так
        final detail = e.toString().replaceFirst(RegExp(r'^Exception:\s*'), '');
        friendlyError = '❌ Ошибка внешнего API:\n$detail\n\n'
            '💡 Частые причины: неверное имя модели или закончился лимит.\n'
            'Открой Настройки → «Обновить модели» и выбери модель из списка.';
      } else if (e.toString().contains('Не удалось подключиться')) {
        friendlyError = '❌ Не удалось подключиться к API. Проверь URL и ключ в настройках.';
      } else if (e.toString().contains('MissingPluginException')) {
        friendlyError = '⚠️ Хранилище недоступно на этой платформе.';
      } else {
        friendlyError = '❌ Ошибка: $e';
      }
      _currentMessages.add(ChatMessage(
        chatId: _currentChat?.id ?? 0,
        role: 'assistant',
        content: friendlyError,
      ));
    }

    _isLoading = false;
    notifyListeners();
  }

  /// Отправка запроса во внешний API (Groq/OpenAI) с инструментами
  Future<_ApiResult> _sendExternalWithTools(
      List<Map<String, dynamic>> messages) async {
    final cleanUrl = _apiUrl.replaceAll(RegExp(r'/+$'), '');
    final url = Uri.parse('$cleanUrl/chat/completions');

    final response = await http.post(
      url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $_apiKey',
      },
      body: jsonEncode({
        'model': _externalModel,
        'messages': messages,
        'tools': _toolService.getToolDefinitions(),
        'tool_choice': 'auto',
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('API error ${response.statusCode}: ${response.body}');
    }

    final data = jsonDecode(response.body);
    final choice = data['choices']?[0];
    final message = choice?['message'];

    // Если модель вернула tool_calls — собираем structured result
    if (message?['tool_calls'] != null) {
      final rawToolCalls = message!['tool_calls'] as List;
      final parsedCalls = <Map<String, dynamic>>[];

      for (final tc in rawToolCalls) {
        parsedCalls.add({
          'id': tc['id'] as String,
          'name': tc['function']['name'] as String,
          'arguments': jsonDecode(tc['function']['arguments'] as String),
        });
      }

      // Формируем assistant-сообщение для обратной отправки в API
      // (содержит tool_calls в формате OpenAI)
      final assistantMsg = <String, dynamic>{
        'role': 'assistant',
        'content': message!['content'] ?? '',
        'tool_calls': rawToolCalls,
      };

      return _ApiResult(
        content: message['content'] ?? '',
        toolCalls: parsedCalls,
        assistantMessage: assistantMsg,
      );
    }

    return _ApiResult(
      content: message?['content'] ?? '',
      toolCalls: [],
      assistantMessage: {'role': 'assistant', 'content': message?['content'] ?? ''},
    );
  }

  /// Отправка запроса в Ollama с инструментами
  Future<_ApiResult> _sendOllamaWithTools(
      List<Map<String, dynamic>> messages) async {
    final url = Uri.parse('${_ollama.baseUrl}/api/chat');
    final response = await http.post(
      url,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'model': _ollama.model,
        'messages': messages,
        'tools': _toolService.getToolDefinitions(),
        'stream': false,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Ollama error ${response.statusCode}: ${response.body}');
    }

    final data = jsonDecode(response.body);
    final message = data['message'];

    // Ollama возвращает tool_calls в message.tool_calls
    if (message?['tool_calls'] != null) {
      final rawToolCalls = message!['tool_calls'] as List;
      final parsedCalls = <Map<String, dynamic>>[];

      for (final tc in rawToolCalls) {
        // Ollama может вернуть id или сгенерировать свой
        final id = tc['id'] ?? 'call_ollama_${DateTime.now().millisecondsSinceEpoch}';
        parsedCalls.add({
          'id': id,
          'name': tc['function']['name'] as String,
          'arguments': tc['function']['arguments'],
        });
      }

      // Формируем assistant-сообщение для обратной отправки
      final assistantMsg = <String, dynamic>{
        'role': 'assistant',
        'content': message!['content'] ?? '',
        'tool_calls': rawToolCalls,
      };

      return _ApiResult(
        content: message['content'] ?? '',
        toolCalls: parsedCalls,
        assistantMessage: assistantMsg,
      );
    }

    return _ApiResult(
      content: message?['content'] ?? '',
      toolCalls: [],
      assistantMessage: {'role': 'assistant', 'content': message?['content'] ?? ''},
    );
  }

  // Живой стриминг-ответ до сохранения в базу
  void _updateStreamingResponse(String partial) {
    _streamingResponse = _filterStreaming(partial);
  }

  String? get streamingResponse => _streamingResponse;
  String? _streamingResponse;

  /// Отслеживание блока <think> во время стриминга
  bool _inThinking = false;

  /// Удалить блок <think>...</think> из ответа модели
  static final _thinkingRe = RegExp(r'<think>[\s\S]*?</think>', dotAll: true);
  static String _stripThinking(String text) {
    return text.replaceAll(_thinkingRe, '').trim();
  }

  /// Отфильтровать стриминг: не показывать текст внутри <think> блока
  String _filterStreaming(String text) {
    final result = StringBuffer();
    var remaining = text;
    while (remaining.isNotEmpty) {
      final openIdx = remaining.indexOf('<thought>');
      final closeIdx = remaining.indexOf('</thought>');
      if (openIdx == -1 && closeIdx == -1) {
        result.write(remaining);
        break;
      }
      if (openIdx != -1 && (openIdx < closeIdx || closeIdx == -1)) {
        result.write(remaining.substring(0, openIdx));
        remaining = remaining.substring(openIdx + 8);
        _inThinking = true;
      } else {
        result.write(remaining.substring(0, closeIdx));
        remaining = remaining.substring(closeIdx + 9);
        _inThinking = false;
      }
    }
    return result.toString().trim();
  }

  /// Update settings
  Future<void> updateSettings({
    String? providerType,
    String? ollamaUrl,
    String? ollamaModel,
    String? apiUrl,
    String? apiKey,
    String? externalModel,
    String? workingDirectory,
    String? githubToken,
  }) async {
    if (providerType != null) {
      await _settings.setProviderType(providerType);
      _providerType = providerType;
    }
    if (ollamaUrl != null) {
      await _settings.setOllamaUrl(ollamaUrl);
      _ollama.baseUrl = ollamaUrl;
    }
    if (ollamaModel != null) {
      await _settings.setOllamaModel(ollamaModel);
      _ollama.model = ollamaModel;
    }
    if (apiUrl != null) {
      await _settings.setApiUrl(apiUrl);
      _apiUrl = apiUrl;
    }
    if (apiKey != null) {
      await _settings.setApiKey(apiKey);
      _apiKey = apiKey;
    }
    if (externalModel != null) {
      await _settings.setExternalModel(externalModel);
      _externalModel = externalModel;
    }
    if (workingDirectory != null) {
      await _settings.setWorkingDirectory(workingDirectory);
      _toolService.setWorkingDirectory(workingDirectory);
    }
    if (githubToken != null) {
      await _settings.setGithubToken(githubToken);
      _toolService.setGithubToken(githubToken);
    }
    notifyListeners();
  }

  /// Get available models for the active provider
  Future<List<String>> getAvailableModels() async {
    if (_providerType == SettingsService.providerExternal) {
      return await OllamaService.listExternalModels(
        apiUrl: _apiUrl,
        apiKey: _apiKey,
      );
    }
    return await _ollama.listModels();
  }

  /// Check connection for the active provider
  Future<bool> checkConnection() async {
    if (_providerType == SettingsService.providerExternal) {
      return await OllamaService.isExternalApiAvailable(
        apiUrl: _apiUrl,
        apiKey: _apiKey,
      );
    }
    return await _ollama.isAvailable();
  }
}
