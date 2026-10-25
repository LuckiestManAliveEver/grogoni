import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val grogoniApiOrigin = providers.gradleProperty("GROGONI_API_ORIGIN")
    .orElse("https://grogoni.com/api")

val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = if (keystorePropertiesFile.exists()) {
    Properties().apply { keystorePropertiesFile.inputStream().use { load(it) } }
} else {
    Properties()
}

val releaseStoreFile = System.getenv("GROGONI_RELEASE_STORE_FILE")
    ?: keystoreProperties.getProperty("storeFile")
    ?: ""
val releaseStorePassword = System.getenv("GROGONI_RELEASE_STORE_PASSWORD")
    ?: keystoreProperties.getProperty("storePassword")
    ?: ""
val releaseKeyAlias = System.getenv("GROGONI_RELEASE_KEY_ALIAS")
    ?: keystoreProperties.getProperty("keyAlias")
    ?: ""
val releaseKeyPassword = System.getenv("GROGONI_RELEASE_KEY_PASSWORD")
    ?: keystoreProperties.getProperty("keyPassword")
    ?: ""

android {
    namespace = "market.grogoni.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "market.grogoni.app"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "GROGONI_API_ORIGIN", "\"${grogoniApiOrigin.get()}\"")
    }

    signingConfigs {
        create("release") {
            if (releaseStoreFile.isNotBlank()) {
                storeFile = file(releaseStoreFile)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (releaseStoreFile.isNotBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.work:work-runtime-ktx:2.10.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core-ktx:1.6.1")
    androidTestImplementation("androidx.test.ext:junit-ktx:1.2.1")
}
