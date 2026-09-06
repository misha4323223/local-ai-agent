import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class OllamaService {
  String baseUrl;
  String model;

  OllamaService({this.baseUrl = 'http://localhost:11434', this.model = 'llama3'});

  /// Send a chat message to Ollama and get streaming response
  Stream<String> chatStream(List<Map<String, String>> messages) async* {
    final url = Uri.parse('$baseUrl/api/chat');
    
    try {
      final request = http.Request('POST', url);
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode({
        'model': model,
        'messages': messages,
        'stream': true,
      });

      final response = await http.Client().send(request);
      
      if (response.statusCode != 200) {
        throw Exception('Ollama API error: ${response.statusCode}');
      }

      String buffer = '';
      
      await for (final chunk in response.stream.transform(utf8.decoder)) {
        buffer += chunk;
        final lines = buffer.split('\n');
        buffer = lines.removeLast();
        
        for (final line in lines) {
          if (line.trim().isEmpty) continue;
          
          try {
            final data = jsonDecode(line);
            if (data['message'] != null && data['message']['content'] != null) {
              yield data['message']['content'];
            }
          } catch (e) {
            // Skip malformed JSON lines
          }
        }
      }
    } catch (e) {
      throw Exception('Failed to connect to Ollama: $e');
    }
  }

  /// Non-streaming chat completion
  Future<String> chat(List<Map<String, String>> messages) async {
    final url = Uri.parse('$baseUrl/api/chat');
    
    final response = await http.post(
      url,
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({
        'model': model,
        'messages': messages,
        'stream': false,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('Ollama API error: ${response.statusCode}');
    }

    final data = jsonDecode(response.body);
    return data['message']['content'] ?? '';
  }

  /// Check if Ollama is available
  Future<bool> isAvailable() async {
    try {
      final url = Uri.parse('$baseUrl/api/tags');
      final response = await http.get(url).timeout(const Duration(seconds: 5));
      return response.statusCode == 200;
    } catch (e) {
      return false;
    }
  }

  /// Check if an external OpenAI-compatible API is available
  static Future<bool> isExternalApiAvailable({
    required String apiUrl,
    required String apiKey,
  }) async {
    try {
      final url = Uri.parse('${apiUrl.replaceAll(RegExp(r'/+$'), '')}/models');
      final response = await http.get(
        url,
        headers: {'Authorization': 'Bearer $apiKey'},
      ).timeout(const Duration(seconds: 10));
      return response.statusCode == 200;
    } catch (e) {
      return false;
    }
  }

  /// List models from an external OpenAI-compatible API
  static Future<List<String>> listExternalModels({
    required String apiUrl,
    required String apiKey,
  }) async {
    try {
      final url = Uri.parse('${apiUrl.replaceAll(RegExp(r'/+$'), '')}/models');
      final response = await http.get(
        url,
        headers: {'Authorization': 'Bearer $apiKey'},
      );

      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final models = data['data'] as List<dynamic>?;
        return models?.map((m) => m['id'].toString()).toList() ?? [];
      }
    } catch (e) {
      // Ignore errors
    }
    return [];
  }

  /// Streaming chat with an external OpenAI-compatible API (Groq, OpenAI, etc.)
  static Stream<String> externalChatStream({
    required String apiUrl,
    required String apiKey,
    required String model,
    required List<Map<String, String>> messages,
  }) async* {
    final cleanUrl = apiUrl.replaceAll(RegExp(r'/+$'), '');
    final url = Uri.parse('$cleanUrl/chat/completions');

    try {
      final request = http.Request('POST', url);
      request.headers['Content-Type'] = 'application/json';
      request.headers['Authorization'] = 'Bearer $apiKey';
      request.body = jsonEncode({
        'model': model,
        'messages': messages,
        'stream': true,
      });

      final response = await http.Client().send(request);

      if (response.statusCode != 200) {
        final body = await response.stream.bytesToString();
        throw Exception('API error ${response.statusCode}: $body');
      }

      String buffer = '';

      await for (final chunk in response.stream.transform(utf8.decoder)) {
        buffer += chunk;
        final lines = buffer.split('\n');
        buffer = lines.removeLast();

        for (final line in lines) {
          final trimmed = line.trim();
          if (trimmed.isEmpty || !trimmed.startsWith('data:')) continue;

          final payload = trimmed.substring(5).trim();
          if (payload == '[DONE]') return;

          try {
            final data = jsonDecode(payload);
            final delta = data['choices']?[0]?['delta'];
            final content = delta?['content'];
            if (content != null && content.toString().isNotEmpty) {
              yield content.toString();
            }
          } catch (e) {
            // Skip malformed JSON chunks
          }
        }
      }
    } catch (e) {
      // Ошибки HTTP уже содержат статус и тело ответа — пробрасываем как есть
      if (e.toString().contains('API error')) rethrow;
      throw Exception('Не удалось подключиться к API: $e');
    }
  }

  /// Non-streaming chat with an external OpenAI-compatible API
  static Future<String> externalChat({
    required String apiUrl,
    required String apiKey,
    required String model,
    required List<Map<String, String>> messages,
  }) async {
    final cleanUrl = apiUrl.replaceAll(RegExp(r'/+$'), '');
    final url = Uri.parse('$cleanUrl/chat/completions');

    final response = await http.post(
      url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $apiKey',
      },
      body: jsonEncode({
        'model': model,
        'messages': messages,
        'stream': false,
      }),
    );

    if (response.statusCode != 200) {
      throw Exception('API error ${response.statusCode}: ${response.body}');
    }

    final data = jsonDecode(response.body);
    return data['choices']?[0]?['message']?['content'] ?? '';
  }

  /// List available models
  Future<List<String>> listModels() async {
    try {
      final url = Uri.parse('$baseUrl/api/tags');
      final response = await http.get(url);
      
      if (response.statusCode == 200) {
        final data = jsonDecode(response.body);
        final models = data['models'] as List<dynamic>?;
        return models?.map((m) => m['name'].toString()).toList() ?? [];
      }
    } catch (e) {
      // Ignore errors
    }
    return [];
  }
}
