import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/chat_provider.dart';
import '../services/settings_service.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  final _ollamaUrlController = TextEditingController();
  final _ollamaModelController = TextEditingController();
  final _apiUrlController = TextEditingController();
  final _apiKeyController = TextEditingController();
  final _externalModelController = TextEditingController();
  final _workingDirController = TextEditingController();
  final _githubTokenController = TextEditingController();

  String _providerType = SettingsService.providerOllama;
  bool _obscureApiKey = true;
  bool _obscureGithubToken = true;
  bool _isTestingConnection = false;
  bool _isLoadingModels = false;
  bool? _connectionSuccess;
  List<String> _availableModels = [];

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  @override
  void dispose() {
    _ollamaUrlController.dispose();
    _ollamaModelController.dispose();
    _apiUrlController.dispose();
    _apiKeyController.dispose();
    _externalModelController.dispose();
    _workingDirController.dispose();
    _githubTokenController.dispose();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    final provider = context.read<ChatProvider>();
    final ollamaUrl = await provider.getOllamaUrl();
    final ollamaModel = await provider.getOllamaModel();
    final apiSettings = await provider.getApiSettings();
    final workingDir = await provider.getWorkingDirectory();
    final githubToken = await provider.settingsService.getGithubToken();

    // Авто-загрузка моделей если ключ и URL уже настроены
    if (apiSettings['apiKey']!.isNotEmpty) {
      final models = await provider.getAvailableModels();
      if (mounted) {
        _availableModels = models;
      }
    }

    if (!mounted) return;
    setState(() {
      _ollamaUrlController.text = ollamaUrl;
      _ollamaModelController.text = ollamaModel;
      _providerType = apiSettings['providerType']!;
      _apiUrlController.text = apiSettings['apiUrl']!;
      _apiKeyController.text = apiSettings['apiKey']!;
      _externalModelController.text = apiSettings['externalModel']!;
      _workingDirController.text = workingDir;
      _githubTokenController.text = githubToken;
    });
  }

  void _applyPreset(String presetKey) {
    final preset = SettingsService.apiPresets[presetKey];
    if (preset == null) return;
    setState(() {
      _apiUrlController.text = preset['url']!;
      _externalModelController.text = preset['model']!;
    });
  }

  /// Загрузить список моделей с активного провайдера
  Future<void> _loadModels() async {
    await _save(silent: true);
    setState(() => _isLoadingModels = true);
    try {
      final provider = context.read<ChatProvider>();
      final models = await provider.getAvailableModels();
      if (!mounted) return;
      setState(() {
        _availableModels = models;
        _isLoadingModels = false;
      });
      _autoSelectModel(models);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(models.isEmpty
              ? 'Модели не найдены. Проверьте URL и ключ.'
              : 'Загружено моделей: ${models.length}. Модель ${_providerType == SettingsService.providerExternal ? _externalModelController.text : _ollamaModelController.text} установлена.'),
          backgroundColor: models.isEmpty ? Colors.orange : Colors.green,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _isLoadingModels = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Ошибка загрузки моделей: $e'), backgroundColor: Colors.red),
      );
    }
  }

  /// Авто-выбор модели: если текущей модели нет в списке — выбираем первую доступную
  void _autoSelectModel(List<String> models) {
    if (models.isEmpty) return;
    if (_providerType == SettingsService.providerExternal) {
      final current = _externalModelController.text.trim();
      if (!models.contains(current)) {
        _externalModelController.text = models.first;
        _save(silent: true);
      }
    } else {
      final current = _ollamaModelController.text.trim();
      if (!models.contains(current)) {
        _ollamaModelController.text = models.first;
        _save(silent: true);
      }
    }
  }

  /// Суффикс поля модели: выпадающий список + кнопка обновления
  Widget? _modelSuffix(TextEditingController controller) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_availableModels.isNotEmpty)
          PopupMenuButton<String>(
            icon: const Icon(Icons.arrow_drop_down),
            onSelected: (model) => setState(() => controller.text = model),
            itemBuilder: (context) => _availableModels
                .map((model) => PopupMenuItem(value: model, child: Text(model)))
                .toList(),
          ),
        IconButton(
          icon: _isLoadingModels
              ? const SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.refresh),
          tooltip: 'Обновить модели',
          onPressed: _isLoadingModels ? null : _loadModels,
        ),
      ],
    );
  }

  Future<void> _testConnection() async {
    // Сначала сохраняем текущие значения, чтобы тест шёл по актуальным настройкам
    await _save(silent: true);

    setState(() => _isTestingConnection = true);

    try {
      final provider = context.read<ChatProvider>();
      final success = await provider.checkConnection();

      setState(() {
        _connectionSuccess = success;
        _isTestingConnection = false;
      });

      if (success) {
        final models = await provider.getAvailableModels();
        if (mounted) {
          setState(() => _availableModels = models);
          _autoSelectModel(models);
        }
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(success
                ? 'Подключение успешно! Загружено моделей: ${_availableModels.length}'
                : 'Не удалось подключиться. Проверьте URL и ключ.'),
            backgroundColor: success ? Colors.green : Colors.red,
          ),
        );
      }
    } catch (e) {
      setState(() => _isTestingConnection = false);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Ошибка: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  Future<void> _save({bool silent = false}) async {
    if (!_formKey.currentState!.validate()) return;

    try {
      final provider = context.read<ChatProvider>();
      await provider.updateSettings(
        providerType: _providerType,
        ollamaUrl: _ollamaUrlController.text.trim(),
        ollamaModel: _ollamaModelController.text.trim(),
        apiUrl: _apiUrlController.text.trim(),
        apiKey: _apiKeyController.text.trim(),
        externalModel: _externalModelController.text.trim(),
        workingDirectory: _workingDirController.text.trim(),
        githubToken: _githubTokenController.text.trim(),
      );

      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Настройки сохранены!'),
            backgroundColor: Colors.green,
          ),
        );
        Navigator.pop(context);
      }
    } catch (e) {
      if (mounted && !silent) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('Ошибка сохранения: $e'),
            backgroundColor: Colors.red,
          ),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Настройки'),
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Form(
          key: _formKey,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Статус подключения
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Icon(
                            _connectionSuccess == null
                                ? Icons.help_outline
                                : _connectionSuccess!
                                    ? Icons.check_circle
                                    : Icons.error,
                            color: _connectionSuccess == null
                                ? Theme.of(context).colorScheme.outline
                                : _connectionSuccess!
                                    ? Colors.green
                                    : Colors.orange,
                          ),
                          const SizedBox(width: 8),
                          Text(
                            _connectionSuccess == null
                                ? 'Подключение не проверялось'
                                : _connectionSuccess!
                                    ? 'Подключено'
                                    : 'Нет подключения',
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ],
                      ),
                      const SizedBox(height: 12),
                      SizedBox(
                        width: double.infinity,
                        child: FilledButton.tonalIcon(
                          onPressed: _isTestingConnection ? null : _testConnection,
                          icon: _isTestingConnection
                              ? const SizedBox(
                                  width: 20,
                                  height: 20,
                                  child: CircularProgressIndicator(strokeWidth: 2),
                                )
                              : const Icon(Icons.wifi_find),
                          label: Text(_isTestingConnection
                              ? 'Проверяем...'
                              : 'Проверить подключение'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),

              // Выбор провайдера
              Text('AI-провайдер', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 12),
              SegmentedButton<String>(
                segments: const [
                  ButtonSegment(
                    value: SettingsService.providerOllama,
                    icon: Icon(Icons.computer),
                    label: Text('Локально'),
                  ),
                  ButtonSegment(
                    value: SettingsService.providerExternal,
                    icon: Icon(Icons.cloud),
                    label: Text('Внешний API'),
                  ),
                ],
                selected: {_providerType},
                onSelectionChanged: (selection) {
                  setState(() {
                    _providerType = selection.first;
                    _connectionSuccess = null;
                    _availableModels = [];
                  });
                },
              ),
              const SizedBox(height: 20),

              // Настройки выбранного провайдера
              if (_providerType == SettingsService.providerOllama) ...[
                Text('Локальный Ollama',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _ollamaUrlController,
                  decoration: const InputDecoration(
                    labelText: 'URL Ollama',
                    hintText: 'http://localhost:11434',
                    prefixIcon: Icon(Icons.link),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Введите URL Ollama';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _ollamaModelController,
                  decoration: InputDecoration(
                    labelText: 'Модель',
                    hintText: 'llama3',
                    prefixIcon: const Icon(Icons.smart_toy),
                    suffixIcon: _modelSuffix(_ollamaModelController),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Введите название модели';
                    }
                    return null;
                  },
                ),
              ] else ...[
                Text('Внешний API (OpenAI-совместимый)',
                    style: Theme.of(context).textTheme.titleMedium),
                const SizedBox(height: 12),

                // Пресеты популярных провайдеров
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: SettingsService.apiPresets.entries.map((entry) {
                    return ActionChip(
                      label: Text(entry.value['name']!),
                      avatar: const Icon(Icons.bolt, size: 18),
                      onPressed: () => _applyPreset(entry.key),
                    );
                  }).toList(),
                ),
                const SizedBox(height: 16),

                TextFormField(
                  controller: _apiUrlController,
                  decoration: const InputDecoration(
                    labelText: 'Базовый URL API',
                    hintText: 'https://api.groq.com/openai/v1',
                    prefixIcon: Icon(Icons.link),
                    helperText:
                        'Например: Groq, OpenAI, OpenRouter, DeepSeek или любой OpenAI-совместимый сервер',
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Введите базовый URL API';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _apiKeyController,
                  obscureText: _obscureApiKey,
                  decoration: InputDecoration(
                    labelText: 'API-ключ',
                    hintText: 'gsk_...',
                    prefixIcon: const Icon(Icons.key),
                    suffixIcon: IconButton(
                      icon: Icon(_obscureApiKey
                          ? Icons.visibility_off
                          : Icons.visibility),
                      onPressed: () {
                        setState(() => _obscureApiKey = !_obscureApiKey);
                      },
                    ),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Введите API-ключ';
                    }
                    return null;
                  },
                ),
                const SizedBox(height: 16),
                TextFormField(
                  controller: _externalModelController,
                  decoration: InputDecoration(
                    labelText: 'Модель',
                    hintText: 'llama-3.3-70b-versatile',
                    prefixIcon: const Icon(Icons.smart_toy),
                    helperText:
                        'Нажмите ↻, чтобы загрузить список моделей с сервера',
                    suffixIcon: _modelSuffix(_externalModelController),
                  ),
                  validator: (value) {
                    if (value == null || value.isEmpty) {
                      return 'Введите название модели';
                    }
                    return null;
                  },
                ),
              ],
              const SizedBox(height: 24),

              // Рабочая директория
              Text('Рабочая директория',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 12),
              TextFormField(
                controller: _workingDirController,
                decoration: const InputDecoration(
                  labelText: 'Путь к папке',
                  hintText: '.',
                  prefixIcon: Icon(Icons.folder),
                  helperText:
                      'Здесь будут выполняться файловые операции и git-команды',
                ),
              ),
              const SizedBox(height: 24),

              // GitHub
              Text('GitHub', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 12),
              TextFormField(
                controller: _githubTokenController,
                obscureText: _obscureGithubToken,
                decoration: InputDecoration(
                  labelText: 'Personal Access Token',
                  hintText: 'ghp_...',
                  prefixIcon: const Icon(Icons.code),
                  helperText:
                      'GitHub → Settings → Developer settings → Personal access tokens, scope «repo». Нужен для клонирования приватных репозиториев и push.',
                  suffixIcon: IconButton(
                    icon: Icon(_obscureGithubToken
                        ? Icons.visibility_off
                        : Icons.visibility),
                    onPressed: () {
                      setState(
                          () => _obscureGithubToken = !_obscureGithubToken);
                    },
                  ),
                ),
              ),
              const SizedBox(height: 32),

              // Кнопка сохранения
              SizedBox(
                width: double.infinity,
                child: FilledButton.icon(
                  onPressed: _save,
                  icon: const Icon(Icons.save),
                  label: const Text('Сохранить настройки'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
