import React from 'react';
import { OptionGroup } from '@/types/course';

type Lang = 'sv' | 'en';

interface OptionGroupModalProps {
  optionGroup: OptionGroup | null;
  language: Lang;
  onClose: () => void;
}

const OptionGroupModal: React.FC<OptionGroupModalProps> = ({ optionGroup, language, onClose }) => {
  if (!optionGroup) return null;

  const ogName = language === 'en' ? (optionGroup.nameEn || optionGroup.name) : optionGroup.name;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: 'white',
          borderRadius: '8px',
          padding: '24px',
          maxWidth: '500px',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.15)',
          fontFamily: 'Figtree, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, Noto Sans',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
          <h2 style={{ margin: 0, color: '#004791', fontSize: '20px' }}>{ogName}</h2>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              fontSize: '24px',
              cursor: 'pointer',
              color: '#999',
              padding: 0,
              width: '32px',
              height: '32px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            ✕
          </button>
        </div>

        {/* Info */}
        <div style={{ marginBottom: '16px', color: '#666', fontSize: '14px' }}>
          <div>{language === 'en' ? 'Total credits:' : 'Totalt poäng:'} <strong>{optionGroup.totalCredits}</strong></div>
          <div style={{ marginTop: '4px' }}>
            {language === 'en' ? 'Year:' : 'År:'} <strong>{optionGroup.year}</strong>
          </div>
        </div>

        {/* Divider */}
        <hr style={{ border: 'none', borderTop: '1px solid #e5e7eb', margin: '16px 0' }} />

        {/* Options */}
        <div>
          <h3 style={{ margin: '0 0 12px 0', color: '#004791', fontSize: '16px' }}>
            {language === 'en' ? 'Available Options:' : 'Tillgängliga val:'}
          </h3>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {optionGroup.options.map((option, index) => (
              <li
                key={index}
                style={{
                  padding: '12px',
                  marginBottom: '8px',
                  backgroundColor: '#f9fafb',
                  borderRadius: '4px',
                  borderLeft: '3px solid #004791',
                }}
              >
                <div style={{ fontWeight: 600, color: '#004791' }}>{option.code}</div>
                <div style={{ color: '#666', fontSize: '14px', marginTop: '4px' }}>
                  {language === 'en' ? (option.nameEn || option.name) : option.name}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Footer */}
        <div style={{ marginTop: '24px', paddingTop: '16px', borderTop: '1px solid #e5e7eb' }}>
          <button
            onClick={onClose}
            style={{
              width: '100%',
              padding: '10px 16px',
              backgroundColor: '#004791',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '14px',
            }}
          >
            {language === 'en' ? 'Close' : 'Stäng'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OptionGroupModal;
