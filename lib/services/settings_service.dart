import 'package:shared_preferences/shared_preferences.dart';

class SettingsService {
  static const String _providerTypeKey = 'provider_type';
  static const String _ollamaUrlKey = 'ollama_url';
  static const String _ollamaModelKey = 'ollama_model';
  static const String _apiUrlKey = 'api_url';
  static const String _apiKeyKey = 'api_key';
  static const String _externalModelKey = 'external_model';
  static const String _workingDirectoryKey = 'working_directory';
  static const String _githubTokenKey = 'github_token';

  /// Типы провайдеров
  static const String providerOllama = 'ollama';
  static const String providerExternal = 'external';

  /// Пресеты внешних OpenAI-совместимых API
  static const Map<String, Map<String, String>> apiPresets = {
    'groq': {
      'name': 'Groq',
      'url': 'https://api.groq.com/openai/v1',
      'model': 'llama-3.3-70b-versatile',
    },
    'openai': {
      'name': 'OpenAI',
      'url': 'https://api.openai.com/v1',
      'model': 'gpt-4o-mini',
    },
    'openrouter': {
      'name': 'OpenRouter',
      'url': 'https://openrouter.ai/api/v1',
      'model': 'meta-llama/llama-3.3-70b-instruct',
    },
    'deepseek': {
      'name': 'DeepSeek',
      'url': 'https://api.deepseek.com/v1',
      'model': 'deepseek-chat',
    },
  };
  
  static const String defaultOllamaUrl = 'http://localhost:11434';
  static const String defaultModel = 'llama3';
  static const String defaultApiUrl = 'https://api.groq.com/openai/v1';
  static const String defaultExternalModel = 'llama-3.3-70b-versatile';
  static const String defaultWorkingDirectory = '.';

  /// Get provider type ('ollama' or 'external')
  Future<String> getProviderType() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_providerTypeKey) ?? providerOllama;
  }

  /// Set provider type
  Future<void> setProviderType(String type) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_providerTypeKey, type);
  }

  /// Get external API base URL
  Future<String> getApiUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_apiUrlKey) ?? defaultApiUrl;
  }

  /// Set external API base URL
  Future<void> setApiUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_apiUrlKey, url);
  }

  /// Get external API key
  Future<String> getApiKey() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_apiKeyKey) ?? '';
  }

  /// Set external API key
  Future<void> setApiKey(String key) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_apiKeyKey, key);
  }

  /// Get external model
  Future<String> getExternalModel() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_externalModelKey) ?? defaultExternalModel;
  }

  /// Set external model
  Future<void> setExternalModel(String model) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_externalModelKey, model);
  }

  /// Get Ollama URL
  Future<String> getOllamaUrl() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_ollamaUrlKey) ?? defaultOllamaUrl;
  }

  /// Set Ollama URL
  Future<void> setOllamaUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_ollamaUrlKey, url);
  }

  /// Get Ollama model
  Future<String> getOllamaModel() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_ollamaModelKey) ?? defaultModel;
  }

  /// Set Ollama model
  Future<void> setOllamaModel(String model) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_ollamaModelKey, model);
  }

  /// Get GitHub personal access token
  Future<String> getGithubToken() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_githubTokenKey) ?? '';
  }

  /// Set GitHub personal access token
  Future<void> setGithubToken(String token) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_githubTokenKey, token);
  }

  /// Get working directory
  Future<String> getWorkingDirectory() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_workingDirectoryKey) ?? defaultWorkingDirectory;
  }

  /// Set working directory
  Future<void> setWorkingDirectory(String directory) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_workingDirectoryKey, directory);
  }

  /// Get all settings
  Future<Map<String, String>> getAllSettings() async {
    return {
      'providerType': await getProviderType(),
      'ollamaUrl': await getOllamaUrl(),
      'ollamaModel': await getOllamaModel(),
      'apiUrl': await getApiUrl(),
      'apiKey': await getApiKey(),
      'externalModel': await getExternalModel(),
      'workingDirectory': await getWorkingDirectory(),
      'githubToken': await getGithubToken(),
    };
  }
}
